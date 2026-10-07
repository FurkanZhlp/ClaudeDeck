import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Info, RotateCw, Timer } from 'lucide-react'
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
import type { Account, AccountUsage, UsageWindow } from '@shared/types'
import { forecast, type UsageWindowKind } from '@shared/usagePace'
import { displayPercent } from '@shared/usageDisplay'
import { formatRelative } from '../notes/relativeTime'
import { useApp } from '../store'
import { AccountRings, RingKey } from './AccountRings'
import { useRingModel, useWindowPercent } from './useRings'
import { Sparkline, type SparkPoint } from './charts'
import { useUsageDisplay } from './display'
import {
  formatCost,
  formatDay,
  formatDuration,
  formatPercent,
  formatResetAt,
  formatTokens
} from './format'
import { meterState, type RingWindow } from './meter'
import { COST_RANGES, dailyTotals, dayTime, rangeTotals, trendDays, type CostRange } from './stats'
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
      <UsageDetailsContent />
    </motion.div>
  )
}

const HERO_RING = 92
const ROW_RING = 44
const WINDOWS: readonly UsageWindowKind[] = ['fiveHour', 'sevenDay']

/**
 * The viewed account as large rings, the other accounts as compact rows, the API-equivalent
 * cost and a refresh footer. Shared by the sidebar popover and the menu bar popover; the
 * parent is a flex column.
 */
export function UsageDetailsContent({
  contentRef
}: {
  /** Wraps the scrollable content, so the menu bar popover can size its window to fit. */
  contentRef?: RefObject<HTMLDivElement | null>
} = {}): React.JSX.Element {
  const accounts = useApp((s) => s.data?.accounts) ?? []
  const selectedId = useApp((s) => s.selectedAccountId)
  const [viewedId, setViewedId] = useState(selectedId)
  const viewed = accounts.find((a) => a.id === viewedId) ?? accounts[0]
  const others = accounts.filter((a) => a.id !== viewed?.id)

  useEffect(() => {
    void useUsage.getState().hydrateDetails()
  }, [])

  return (
    <>
      <div className="scroll-area min-h-0 flex-1 overflow-y-auto">
        <div ref={contentRef}>
          {viewed && <HeroAccount account={viewed} />}
          {others.length > 0 && <OtherAccounts accounts={others} onView={setViewedId} />}
          <CostSection />
        </div>
      </div>
      {viewed && <Footer account={viewed} />}
    </>
  )
}

/** Soonest "runs out before reset" forecast of an account, if any. */
function useRunsOut(
  usage: AccountUsage | undefined
): { kind: UsageWindowKind; inMs: number } | null {
  const now = useUsage((s) => s.now)
  if (!usage) return null
  return WINDOWS.reduce<{ kind: UsageWindowKind; inMs: number } | null>((best, kind) => {
    const value = forecast(usage[kind], kind, now)
    if (value?.kind !== 'runsOut' || (best && best.inMs <= value.inMs)) return best
    return { kind, inMs: value.inMs }
  }, null)
}

function HeroAccount({ account }: { account: Account }): React.JSX.Element {
  const { t } = useTranslation()
  const usage = useUsage((s) => s.byAccount[account.id])
  const plan = useUsage((s) => s.plans[account.id])
  const display = useUsageDisplay()
  const model = useRingModel(account, usage)
  const runsOut = useRunsOut(usage)
  const extra =
    plan?.extraUsageEnabled === true
      ? t('usage.details.extraOn')
      : plan?.extraUsageEnabled === false
        ? t('usage.details.extraOff')
        : null

  return (
    <section aria-labelledby="usage-account-title" className="px-4 pb-3.5 pt-4">
      <div className="flex items-center gap-4">
        <AccountRings account={account} usage={usage} size={HERO_RING} center />
        <div className="min-w-0 flex-1">
          <h2 id="usage-account-title" className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ background: account.color }}
            />
            <span className="truncate text-[13px] font-semibold">{account.name}</span>
            {plan?.label && <span className="shrink-0 text-[11px] text-muted">{plan.label}</span>}
          </h2>
          {usage ? (
            <dl className="mt-2.5 space-y-2">
              <WindowRow
                label={t('usage.details.session')}
                window={model.session}
                source={usage.fiveHour}
                color={account.color}
              />
              <WindowRow
                label={t('usage.details.weekly')}
                window={model.weekly}
                source={usage.sevenDay}
                color={account.color}
              />
            </dl>
          ) : (
            <p className="mt-2 text-[11.5px] leading-snug text-muted">
              {t('usage.details.noUsage')}
            </p>
          )}
        </div>
      </div>

      {runsOut && (
        <p
          role="status"
          className="mt-3 flex items-center gap-1.5 text-[11.5px] leading-snug text-danger"
        >
          <Timer size={12} aria-hidden className="shrink-0" />
          <span>
            <span className="font-semibold">
              {t(`usage.details.${runsOut.kind === 'fiveHour' ? 'session' : 'weekly'}`)}:
            </span>{' '}
            {t('usage.forecast.runsOut', { time: formatDuration(runsOut.inMs, t) })}
          </span>
        </p>
      )}

      {usage?.models && usage.models.length > 0 && (
        <dl className="mt-3 space-y-1">
          {usage.models.map((item) => (
            <ModelRow key={item.model} label={item.model} window={item} />
          ))}
        </dl>
      )}

      <div className="mt-3 flex items-center justify-between gap-3 text-[10.5px] text-muted">
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-[1.5px] shrink-0 rounded-full bg-fg" />
          <span className="truncate">
            {t(display === 'used' ? 'usage.ring.legendUsed' : 'usage.ring.legendRemaining')}
          </span>
        </span>
        {extra && <span className="shrink-0">{t('usage.ring.extra', { state: extra })}</span>}
      </div>
    </section>
  )
}

function WindowRow({
  label,
  window,
  source,
  color
}: {
  label: string
  window: RingWindow
  source: UsageWindow | null
  color: string
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const now = useUsage((s) => s.now)
  const percent = useWindowPercent()
  const tone =
    window.level === 'danger' ? 'text-danger' : window.level === 'warn' ? 'text-warn' : ''
  const detail = !source
    ? t('usage.details.noData')
    : window.reset
      ? t('usage.ring.resetDone')
      : t('usage.ring.resets', {
          at: formatResetAt(source.resetsAt, i18n.language, now),
          in: formatDuration(source.resetsAt - now, t)
        })
  const tooltip = source && window.reset ? t('usage.details.resetDone') : detail

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <dt className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <RingKey kind={window.kind} color={color} />
          {label}
        </dt>
        <dd className={`text-[13px] font-semibold tabular-nums ${source ? tone : 'text-muted'}`}>
          {source ? percent(window) : ''}
        </dd>
      </div>
      <div className="mt-0.5 truncate pl-4 text-[10.5px] text-muted" data-tooltip={tooltip}>
        {detail}
      </div>
    </div>
  )
}

/** Per-model weekly limit, one quiet line. */
function ModelRow({ label, window }: { label: string; window: UsageWindow }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const now = useUsage((s) => s.now)
  const display = useUsageDisplay()
  const state = meterState(window, 'sevenDay', now)
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
      <dt className="truncate">{t('usage.ring.model', { model: label })}</dt>
      <dd className="shrink-0 font-medium tabular-nums text-fg">
        {formatPercent(displayPercent(state.used, display), i18n.language)}
      </dd>
    </div>
  )
}

function OtherAccounts({
  accounts,
  onView
}: {
  accounts: Account[]
  onView: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ul aria-label={t('usage.details.accounts')} className="border-t border-border px-2 py-1.5">
      {accounts.map((account) => (
        <li key={account.id}>
          <AccountRow account={account} onView={() => onView(account.id)} />
        </li>
      ))}
    </ul>
  )
}

function AccountRow({
  account,
  onView
}: {
  account: Account
  onView: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const usage = useUsage((s) => s.byAccount[account.id])
  const model = useRingModel(account, usage)
  const percent = useWindowPercent()
  const runsOut = useRunsOut(usage)
  const value = (window: RingWindow): React.JSX.Element => (
    <span
      className={`font-medium tabular-nums ${window.level === 'danger' ? 'text-danger' : window.level === 'warn' ? 'text-warn' : 'text-fg'}`}
    >
      {window.active ? percent(window) : t('usage.noWindow')}
    </span>
  )

  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-fg/[0.05] focus-visible:outline-2 focus-visible:outline-accent"
      onClick={onView}
    >
      <AccountRings account={account} usage={usage} size={ROW_RING} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: account.color }}
          />
          <span className="truncate text-[12px] font-medium">{account.name}</span>
        </span>
        {usage ? (
          <span className="mt-0.5 flex gap-3 text-[11px] text-muted">
            <span>
              {t('usage.details.session')} {value(model.session)}
            </span>
            <span>
              {t('usage.details.weekly')} {value(model.weekly)}
            </span>
          </span>
        ) : (
          <span className="mt-0.5 block text-[11px] text-muted">{t('usage.details.noData')}</span>
        )}
      </span>
      {runsOut && (
        <span
          className="shrink-0 text-danger"
          data-tooltip={t('usage.forecast.runsOut', { time: formatDuration(runsOut.inMs, t) })}
        >
          <Timer size={13} aria-hidden />
          <span className="sr-only">
            {t('usage.forecast.runsOut', { time: formatDuration(runsOut.inMs, t) })}
          </span>
        </span>
      )}
    </button>
  )
}

function CostSection(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const [range, setRange] = useState<CostRange>('today')
  const statsById = useUsage((s) => s.stats)
  const status = useUsage((s) => s.detailsStatus)
  const now = useUsage((s) => s.now)
  const stats = Object.values(statsById)
  const totals = rangeTotals(stats, range, now)
  const days = dailyTotals(stats, trendDays(range), now)
  const peak = Math.max(0, ...days.map((day) => day.costUSD))
  const points: SparkPoint[] = days.map((day) => ({
    key: day.date,
    value: day.costUSD,
    tooltip: t('usage.details.barTooltip', {
      date: formatDay(dayTime(day.date), language),
      cost: formatCost(day.costUSD, language),
      tokens: t('usage.details.tokens', { value: formatTokens(day.tokens, language) })
    })
  }))

  return (
    <section aria-labelledby="usage-cost-title" className="border-t border-border px-4 pb-3.5 pt-3">
      <div className="flex items-center justify-between gap-3">
        <h2
          id="usage-cost-title"
          className="flex items-center gap-1 text-[11.5px] font-medium text-muted"
        >
          {t('usage.ring.apiEquivalent')}
          <span
            role="img"
            tabIndex={0}
            aria-label={t('usage.details.estimateNote')}
            data-tooltip={t('usage.details.estimateNote')}
            className="rounded-full p-0.5 text-muted/80 outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Info size={11} aria-hidden />
          </span>
        </h2>
        <div role="group" aria-label={t('usage.details.range.label')} className="flex gap-2.5">
          {COST_RANGES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={range === value}
              className={`relative rounded text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${range === value ? 'font-medium text-fg' : 'text-muted hover:text-fg'}`}
              onClick={() => setRange(value)}
            >
              {t(`usage.details.range.${value}`)}
              {range === value && (
                <span
                  aria-hidden
                  className="absolute inset-x-0 -bottom-1 mx-auto h-[1.5px] w-3 rounded-full bg-fg"
                />
              )}
            </button>
          ))}
        </div>
      </div>

      {status === 'ready' && stats.length === 0 ? (
        <p className="mt-2 text-[11.5px] leading-snug text-muted">{t('usage.details.noStats')}</p>
      ) : (
        <div className="mt-2 flex items-end gap-4">
          <div className="shrink-0 leading-tight">
            <div className="text-[17px] font-semibold tabular-nums">
              {formatCost(totals.costUSD, language)}
            </div>
            <div className="text-[10.5px] tabular-nums text-muted">
              {t('usage.details.tokens', { value: formatTokens(totals.tokens, language) })}
            </div>
          </div>
          <div className="min-w-0 flex-1 pb-0.5">
            <Sparkline
              key={range}
              points={points}
              color="var(--muted)"
              label={t('usage.ring.sparkLabel', {
                days: days.length,
                max: formatCost(peak, language)
              })}
            />
          </div>
        </div>
      )}
    </section>
  )
}

function Footer({ account }: { account: Account }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const usage: AccountUsage | undefined = useUsage((s) => s.byAccount[account.id])
  const now = useUsage((s) => s.now)
  const [busy, setBusy] = useState(false)
  const nextAt = usage ? usage.updatedAt + POLL_INTERVAL_MS : null
  const next =
    nextAt !== null && nextAt > now
      ? t('usage.details.nextUpdate', { time: formatDuration(nextAt - now, t) })
      : null

  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      await useUsage.getState().refresh(account.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <footer className="flex items-center gap-2 border-t border-border py-1.5 pl-4 pr-2 text-[11px] text-muted">
      <span className="min-w-0 flex-1 truncate" data-tooltip={next ?? undefined}>
        {usage
          ? t('usage.details.updated', {
              time: formatRelative(usage.updatedAt, i18n.language, now)
            })
          : t('usage.details.noData')}
      </span>
      <button
        type="button"
        aria-label={busy ? t('usage.details.refreshing') : t('usage.details.refresh')}
        data-tooltip={next ? `${t('usage.details.refresh')}. ${next}` : t('usage.details.refresh')}
        disabled={busy}
        className="no-drag rounded-md p-1.5 text-muted transition-colors hover:bg-fg/[0.06] hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default"
        onClick={() => void refresh()}
      >
        <RotateCw size={13} aria-hidden className={busy ? 'animate-spin' : undefined} />
      </button>
    </footer>
  )
}
