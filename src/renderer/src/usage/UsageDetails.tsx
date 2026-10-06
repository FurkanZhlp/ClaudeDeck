import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { RotateCw } from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Account, AccountStats, AccountUsage, UsageWindow } from '@shared/types'
import type { UsageWindowKind } from '@shared/usagePace'
import { formatRelative } from '../notes/relativeTime'
import { useApp } from '../store'
import { Donut, TrendBars, type TrendBar } from './charts'
import {
  formatCost,
  formatDay,
  formatDuration,
  formatPercent,
  formatResetLabel,
  formatTokens
} from './format'
import { LEVEL_COLOR, meterState } from './meter'
import { COST_RANGES, dayKey, dayTime, rangeTotals, totalTokens, type CostRange } from './stats'
import { useUsage } from './usageStore'

const WIDTH = 360
const GAP = 8
/** Keeps the popover clear of the title bar. */
const TOP_MARGIN = 44
/** Below this much room above the panel the popover opens to the right of the sidebar. */
const MIN_ABOVE = 420
/** The main process re-reads plan usage on this cadence. */
const POLL_INTERVAL_MS = 5 * 60_000

const EASE_OUT = [0.22, 1, 0.36, 1] as const

interface Props {
  open: boolean
  /** The usage panel; the popover grows out of it and clicks on it do not count as outside. */
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
}

/** Usage details popover anchored to the sidebar usage panel. */
export function UsageDetails({ open, anchorRef, onClose }: Props): React.JSX.Element {
  return createPortal(
    <AnimatePresence>
      {open && <Popover key="usage-details" anchorRef={anchorRef} onClose={onClose} />}
    </AnimatePresence>,
    document.body
  )
}

interface Placement {
  style: CSSProperties
  origin: string
}

function place(anchor: DOMRect): Placement {
  const { innerWidth, innerHeight } = window
  const maxHeight = innerHeight - 80
  const above = anchor.top - GAP - TOP_MARGIN
  if (above >= Math.min(MIN_ABOVE, maxHeight)) {
    const left = anchor.left + GAP
    return {
      style: {
        left,
        bottom: innerHeight - anchor.top + GAP,
        width: Math.min(WIDTH, innerWidth - left - GAP),
        maxHeight: Math.min(above, maxHeight)
      },
      origin: 'bottom left'
    }
  }
  const left = anchor.right + GAP
  return {
    style: {
      left,
      bottom: Math.max(GAP, innerHeight - anchor.bottom),
      width: Math.min(WIDTH, innerWidth - left - GAP),
      maxHeight
    },
    origin: 'bottom left'
  }
}

function Popover({ anchorRef, onClose }: Omit<Props, 'open'>): React.JSX.Element {
  const { t } = useTranslation()
  const reduced = useReducedMotion() ?? false
  const ref = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)

  useLayoutEffect(() => {
    const update = (): void => {
      const anchor = anchorRef.current
      if (anchor) setPlacement(place(anchor.getBoundingClientRect()))
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [anchorRef])

  useEffect(() => {
    void useUsage.getState().hydrateDetails()
    ref.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // A full-window screen (sign-in, onboarding) above handles its own keys.
      if (event.key !== 'Escape' || document.querySelector('[data-screen]')) return
      event.preventDefault()
      onClose()
      anchorRef.current?.querySelector<HTMLElement>('[aria-expanded]')?.focus()
    }
    const onPointer = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (!target || ref.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer, true)
    }
  }, [anchorRef, onClose])

  return (
    <motion.div
      ref={ref}
      id="usage-details"
      role="dialog"
      aria-label={t('usage.details.title')}
      tabIndex={-1}
      className="no-drag fixed z-[60] flex flex-col overflow-hidden rounded-2xl border border-border bg-elevated text-fg shadow-2xl outline-none"
      style={{
        ...(placement?.style ?? { left: 0, bottom: 0, width: WIDTH, visibility: 'hidden' }),
        transformOrigin: placement?.origin
      }}
      initial={{ opacity: 0, scale: reduced ? 1 : 0.95, y: reduced ? 0 : 8 }}
      animate={{
        opacity: 1,
        scale: 1,
        y: 0,
        transition: reduced ? { duration: 0.12 } : { duration: 0.24, ease: EASE_OUT }
      }}
      exit={{
        opacity: 0,
        scale: reduced ? 1 : 0.97,
        y: reduced ? 0 : 6,
        transition: { duration: reduced ? 0.1 : 0.16 }
      }}
    >
      <DetailsContent />
    </motion.div>
  )
}

function DetailsContent(): React.JSX.Element {
  const accounts = useApp((s) => s.data?.accounts) ?? []
  const selectedId = useApp((s) => s.selectedAccountId)
  const [viewedId, setViewedId] = useState(selectedId)
  const viewed = accounts.find((a) => a.id === viewedId) ?? accounts[0]

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <CostSection accounts={accounts} />
        {viewed && (
          <AccountSection account={viewed} accounts={accounts} onView={(id) => setViewedId(id)} />
        )}
      </div>
      {viewed && <Footer account={viewed} />}
    </>
  )
}

function CostSection({ accounts }: { accounts: Account[] }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const [range, setRange] = useState<CostRange>('today')
  const stats = useUsage((s) => s.stats)
  const status = useUsage((s) => s.detailsStatus)
  const now = useUsage((s) => s.now)
  const hasStats = Object.keys(stats).length > 0

  const rows = accounts.map((account) => ({
    account,
    totals: rangeTotals(stats[account.id], range, now)
  }))
  const total = rows.reduce((sum, row) => sum + row.totals.costUSD, 0)
  const rangeLabel = t(`usage.details.range.${range}`)

  return (
    <section aria-labelledby="usage-cost-title" className="px-4 pb-4 pt-3.5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="usage-cost-title" className="text-[13px] font-semibold">
          {t('usage.details.cost')}
        </h2>
        <div
          role="group"
          aria-label={t('usage.details.range.label')}
          className="flex rounded-lg bg-fg/[0.06] p-0.5"
        >
          {COST_RANGES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={range === value}
              className={`rounded-md px-2 py-0.5 text-[11.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent ${range === value ? 'bg-elevated text-fg shadow-sm' : 'text-muted hover:text-fg'}`}
              onClick={() => setRange(value)}
            >
              {t(`usage.details.range.${value}`)}
            </button>
          ))}
        </div>
      </div>

      {status === 'ready' && !hasStats ? (
        <p className="mt-3 text-[11.5px] leading-snug text-muted">{t('usage.details.noStats')}</p>
      ) : (
        <div className="mt-3 flex items-center gap-4">
          <Donut
            segments={rows.map(({ account, totals }) => ({
              id: account.id,
              color: account.color,
              value: totals.costUSD
            }))}
            label={t('usage.details.chartLabel', {
              range: rangeLabel,
              total: formatCost(total, language, false)
            })}
          >
            <span className="text-[17px] font-semibold tabular-nums leading-tight">
              {formatCost(total, language)}
            </span>
            <span className="text-[10.5px] text-muted">{rangeLabel}</span>
          </Donut>
          <ul className="min-w-0 flex-1 space-y-1.5">
            {rows.map(({ account, totals }) => (
              <li key={account.id} className="flex items-center gap-2 text-[11.5px]">
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-[3px]"
                  style={{ background: account.color }}
                />
                <span className="min-w-0 flex-1 truncate">{account.name}</span>
                <span className="tabular-nums text-muted">
                  {formatCost(totals.costUSD, language)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 text-[10.5px] leading-snug text-muted">
        {t('usage.details.estimateNote')}
      </p>
    </section>
  )
}

function AccountSection({
  account,
  accounts,
  onView
}: {
  account: Account
  accounts: Account[]
  onView: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const usage = useUsage((s) => s.byAccount[account.id])
  const plan = useUsage((s) => s.plans[account.id])
  const stats = useUsage((s) => s.stats[account.id])
  const status = useUsage((s) => s.detailsStatus)
  const extra =
    plan?.extraUsageEnabled === true
      ? t('usage.details.extraOn')
      : plan?.extraUsageEnabled === false
        ? t('usage.details.extraOff')
        : t('usage.details.noData')

  return (
    <section
      aria-labelledby="usage-account-title"
      className="border-t border-border px-4 pb-4 pt-3.5"
    >
      <div className="flex items-center gap-2">
        <h2 id="usage-account-title" className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] font-semibold">{account.name}</span>
          {plan?.label && <span className="shrink-0 text-[11.5px] text-muted">{plan.label}</span>}
        </h2>
        {accounts.length > 1 && (
          <div
            role="group"
            aria-label={t('usage.details.accounts')}
            className="ml-auto flex shrink-0 items-center gap-0.5"
          >
            {accounts.map((other) => (
              <button
                key={other.id}
                type="button"
                aria-pressed={other.id === account.id}
                aria-label={t('usage.details.viewAccount', { name: other.name })}
                data-tooltip={other.name}
                className="flex size-5 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-accent"
                onClick={() => onView(other.id)}
              >
                <span
                  aria-hidden
                  className={`rounded-full transition-all ${other.id === account.id ? 'size-3 ring-2 ring-offset-1 ring-offset-elevated' : 'size-2.5 opacity-60 hover:opacity-100'}`}
                  style={
                    {
                      background: other.color,
                      '--tw-ring-color': other.color
                    } as CSSProperties
                  }
                />
              </button>
            ))}
          </div>
        )}
      </div>

      {usage ? (
        <div className="mt-3 space-y-3">
          <DetailMeter label={t('usage.details.session')} kind="fiveHour" window={usage.fiveHour} />
          <DetailMeter label={t('usage.details.weekly')} kind="sevenDay" window={usage.sevenDay} />
          {usage.models?.map((model) => (
            <DetailMeter key={model.model} label={model.model} kind="sevenDay" window={model} />
          ))}
        </div>
      ) : (
        <p className="mt-3 text-[11.5px] leading-snug text-muted">{t('usage.details.noUsage')}</p>
      )}

      <div className="mt-3 flex items-baseline justify-between text-[11.5px]">
        <span className="text-muted">{t('usage.details.extraUsage')}</span>
        <span className={plan?.extraUsageEnabled == null ? 'text-muted' : 'font-medium'}>
          {extra}
        </span>
      </div>

      {stats ? (
        <StatsBlock account={account} stats={stats} />
      ) : (
        status === 'ready' && (
          <p className="mt-3 text-[11.5px] leading-snug text-muted">{t('usage.details.noStats')}</p>
        )
      )}
    </section>
  )
}

function DetailMeter({
  label,
  kind,
  window
}: {
  label: string
  kind: UsageWindowKind
  window: UsageWindow | null
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const reduced = useReducedMotion() ?? false
  const now = useUsage((s) => s.now)
  const language = i18n.language
  const { used, reset, level } = meterState(window, kind, now)
  const left = 100 - used
  const active = window !== null && !reset

  const value = active
    ? t('usage.details.left', { percent: formatPercent(left, language) })
    : t('usage.details.noData')
  const detail = !window
    ? null
    : reset
      ? t('usage.details.resetDone')
      : formatResetLabel(window.resetsAt, language, now, t)

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
        <span className="truncate font-medium">{label}</span>
        <span className={`shrink-0 tabular-nums ${active ? '' : 'text-muted'}`}>{value}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(left)}
        aria-valuetext={detail ? `${value}, ${detail}` : value}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-fg/10"
      >
        <motion.div
          className="h-full origin-left rounded-full"
          style={{ background: LEVEL_COLOR[level] }}
          initial={{ scaleX: reduced ? (active ? left / 100 : 0) : 0 }}
          animate={{ scaleX: active ? left / 100 : 0 }}
          transition={reduced ? { duration: 0 } : { duration: 0.6, ease: EASE_OUT, delay: 0.1 }}
        />
      </div>
      {detail && <div className="mt-1 text-[10.5px] text-muted">{detail}</div>}
    </div>
  )
}

function StatsBlock({
  account,
  stats
}: {
  account: Account
  stats: AccountStats
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const now = useUsage((s) => s.now)
  const today = dayKey(now)

  const bars: TrendBar[] = stats.days.map((day) => ({
    key: day.date,
    value: day.costUSD,
    highlight: day.date === today,
    tooltip: t('usage.details.barTooltip', {
      date: formatDay(dayTime(day.date), language),
      cost: formatCost(day.costUSD, language),
      tokens: t('usage.details.tokens', { value: formatTokens(totalTokens(day.tokens), language) })
    })
  }))
  const peak = Math.max(0, ...stats.days.map((day) => day.costUSD))
  const rows: Array<{ range: CostRange; label: string }> = [
    { range: 'today', label: t('usage.details.rows.today') },
    { range: 'yesterday', label: t('usage.details.rows.yesterday') },
    { range: 'month', label: t('usage.details.rows.month') }
  ]

  return (
    <>
      <div className="mt-4">
        <h3 className="mb-1.5 text-[11.5px] font-medium">{t('usage.details.trend')}</h3>
        <TrendBars
          key={account.id}
          bars={bars}
          color={account.color}
          label={t('usage.details.trendLabel', { max: formatCost(peak, language) })}
        />
      </div>
      <dl className="mt-3 space-y-1.5 text-[11.5px]">
        {rows.map(({ range, label }) => {
          const totals = rangeTotals(stats, range, now)
          return (
            <div key={range} className="flex items-baseline justify-between gap-2">
              <dt className="text-muted">{label}</dt>
              <dd className="truncate tabular-nums">
                <span className="font-medium">{formatCost(totals.costUSD, language)}</span>
                <span className="text-muted">
                  {' · '}
                  {t('usage.details.tokens', { value: formatTokens(totals.tokens, language) })}
                </span>
              </dd>
            </div>
          )
        })}
      </dl>
    </>
  )
}

function Footer({ account }: { account: Account }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const usage: AccountUsage | undefined = useUsage((s) => s.byAccount[account.id])
  const now = useUsage((s) => s.now)
  const [busy, setBusy] = useState(false)
  const nextAt = usage ? usage.updatedAt + POLL_INTERVAL_MS : null

  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      await useUsage.getState().refresh(account.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <footer className="flex items-center gap-2 border-t border-border px-4 py-2.5 text-[11px] text-muted">
      <div className="min-w-0 flex-1 leading-snug">
        {usage && (
          <div className="truncate">
            {t('usage.details.updated', {
              time: formatRelative(usage.updatedAt, i18n.language, now)
            })}
          </div>
        )}
        {nextAt !== null && nextAt > now && (
          <div className="truncate">
            {t('usage.details.nextUpdate', { time: formatDuration(nextAt - now, t) })}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label={busy ? t('usage.details.refreshing') : t('usage.details.refresh')}
        data-tooltip={t('usage.details.refresh')}
        disabled={busy}
        className="no-drag rounded-md p-1.5 text-muted transition-colors hover:bg-fg/[0.06] hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default"
        onClick={() => void refresh()}
      >
        <RotateCw size={13} aria-hidden className={busy ? 'animate-spin' : undefined} />
      </button>
    </footer>
  )
}
