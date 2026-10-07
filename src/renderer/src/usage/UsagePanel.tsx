import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react'
import { Settings, Timer, TrendingDown, TrendingUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Account, AccountUsage, UsageWindow } from '@shared/types'
import { useCallback, useRef, useState } from 'react'
import { forecast, type Forecast, type UsageWindowKind } from '@shared/usagePace'
import { formatRelative } from '../notes/relativeTime'
import { useApp } from '../store'
import { formatDuration, formatPercent, formatResetAt } from './format'
import { displayPercent } from '@shared/usageDisplay'
import { useUsageDisplay } from './display'
import { LEVEL_COLOR, meterFill, meterState } from './meter'
import { UsageDetails } from './UsageDetails'
import { useAccountUsage, useUsage } from './usageStore'

/** Reports older than this get a "x min ago" hint; Claude Code only reports while it runs. */
const STALE_AFTER_MS = 10 * 60_000

const WINDOWS: readonly UsageWindowKind[] = ['fiveHour', 'sevenDay']

const EASE_OUT = [0.22, 1, 0.36, 1] as const
const FILL_S = 0.6

/** The forecast line slides up in and fades up out; only fades when motion is reduced. */
const forecastVariants = (reduced: boolean): Variants => ({
  initial: { opacity: 0, y: reduced ? 0 : 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.24, ease: EASE_OUT } },
  exit: { opacity: 0, y: reduced ? 0 : -4, transition: { duration: 0.16 } }
})

/** Discord style user panel at the bottom of the sidebar, focused on plan usage. */
export function UsagePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const account = useApp((s) => s.data?.accounts.find((a) => a.id === s.selectedAccountId))
  const usage = useAccountUsage(account?.id ?? null)
  const ref = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const expanded = open && account !== undefined

  return (
    <section
      ref={ref}
      aria-label={t('usage.title')}
      className={`relative border-t border-border transition-colors ${expanded ? 'bg-fg/[0.07]' : 'bg-fg/[0.035]'}`}
    >
      {account ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-haspopup="dialog"
          aria-controls={expanded ? 'usage-details' : undefined}
          className="no-drag block w-full px-2.5 pb-2.5 pt-2 text-left transition-colors hover:bg-fg/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="sr-only">{t('usage.details.open')}</span>
          <span className="flex min-h-7 items-center pr-8">
            <AccountIdentity account={account} usage={usage} />
          </span>
          {usage ? (
            <UsageMeters usage={usage} />
          ) : (
            <span className="mt-1.5 block text-[11px] leading-snug text-muted">
              {t('usage.empty')}
            </span>
          )}
        </button>
      ) : (
        <div className="h-11" />
      )}
      <button
        type="button"
        aria-label={t('sidebar.settings')}
        data-tooltip={t('sidebar.settings')}
        className="no-drag absolute right-2.5 top-2 rounded-md p-1.5 text-muted transition-colors hover:bg-elevated hover:text-fg"
        onClick={(event) => {
          event.stopPropagation()
          setOpen(false)
          useApp.getState().setSettingsOpen(true)
        }}
      >
        <Settings size={15} />
      </button>
      {account && <UsageDetails open={expanded} anchorRef={ref} onClose={close} />}
    </section>
  )
}

function AccountIdentity({
  account,
  usage
}: {
  account: Account
  usage: AccountUsage | undefined
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const now = useUsage((s) => s.now)
  const stale = usage !== undefined && now - usage.updatedAt > STALE_AFTER_MS
  const ago = usage ? formatRelative(usage.updatedAt, i18n.language, now) : ''

  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded-lg text-[12px] font-semibold text-white"
        style={{ background: account.color }}
      >
        {account.name.trim().charAt(0).toLocaleUpperCase()}
      </span>
      <span className="block min-w-0 leading-tight">
        <span className="block truncate text-[12px] font-semibold">{account.name}</span>
        {stale && (
          <span
            className="block truncate text-[10.5px] text-muted"
            data-tooltip={t('usage.staleTooltip', { time: ago })}
          >
            {ago}
          </span>
        )}
      </span>
    </span>
  )
}

function UsageMeters({ usage }: { usage: AccountUsage }): React.JSX.Element {
  const now = useUsage((s) => s.now)
  const reduced = useReducedMotion() ?? false
  const notice = pickForecast(usage, now)

  return (
    <>
      <span className="mt-2 block space-y-1.5">
        {WINDOWS.map((kind) => (
          <Meter key={kind} kind={kind} window={usage[kind]} now={now} />
        ))}
      </span>
      <AnimatePresence initial={false}>
        {notice && (
          <motion.span
            className="block"
            key={`${notice.window}:${notice.forecast.kind}`}
            variants={forecastVariants(reduced)}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            <ForecastLine window={notice.window} forecast={notice.forecast} />
          </motion.span>
        )}
      </AnimatePresence>
    </>
  )
}

function Meter({
  kind,
  window,
  now
}: {
  kind: UsageWindowKind
  window: UsageWindow | null
  now: number
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const reduced = useReducedMotion() ?? false
  const display = useUsageDisplay()
  const language = i18n.language
  const label = t(`usage.${kind}`)
  const longLabel = t(`usage.${kind}Long`)
  const state = meterState(window, kind, now)
  const { used, reset, level } = state
  const shown = formatPercent(displayPercent(used, display), language)
  const percent = display === 'used' ? shown : t('usage.details.left', { percent: shown })
  const fill = meterFill(window, state, display)

  let detail: string
  let tooltip: string
  if (!window) {
    detail = t('usage.noWindow')
    tooltip = t('usage.tooltip.empty', { window: longLabel })
  } else if (reset) {
    detail = t('usage.reset')
    tooltip = t('usage.tooltip.reset', { window: longLabel })
  } else {
    const resetIn = formatDuration(window.resetsAt - now, t)
    detail = resetIn
    tooltip = t('usage.tooltip.active', {
      window: longLabel,
      percent: formatPercent(window.usedPercentage, language),
      at: formatResetAt(window.resetsAt, language, now),
      in: resetIn
    })
  }

  return (
    <span className="block" data-tooltip={tooltip}>
      <span className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="truncate tabular-nums">
          {window && <span className="font-medium text-fg">{percent}</span>}
          <span className="text-muted">
            {window ? ' · ' : ''}
            {detail}
          </span>
        </span>
      </span>
      <span
        role="meter"
        aria-label={longLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fill)}
        aria-valuetext={window ? `${percent}, ${detail}` : detail}
        className="mt-1 block h-1 overflow-hidden rounded-full bg-fg/10"
      >
        <motion.span
          className="block h-full origin-left rounded-full transition-colors duration-300"
          style={{ background: LEVEL_COLOR[level] }}
          initial={false}
          animate={{ scaleX: fill / 100 }}
          transition={reduced ? { duration: 0 } : { duration: FILL_S, ease: EASE_OUT }}
        />
      </span>
    </span>
  )
}

function ForecastLine({
  window,
  forecast: value
}: {
  window: UsageWindowKind
  forecast: Forecast
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const percent = formatPercent(value.percent, i18n.language)
  const good = value.kind === 'under'
  const Icon = value.kind === 'runsOut' ? Timer : good ? TrendingDown : TrendingUp
  const text =
    value.kind === 'runsOut'
      ? t('usage.forecast.runsOut', { time: formatDuration(value.inMs, t) })
      : t(`usage.forecast.${value.kind}`, { percent })
  const tooltip =
    value.kind === 'runsOut'
      ? t('usage.forecast.runsOutDetail', { window: t(`usage.${window}Long`), percent })
      : t('usage.forecast.basis', { window: t(`usage.${window}Long`) })

  return (
    <span
      role="status"
      data-tooltip={tooltip}
      className={`mt-2 flex items-start gap-1.5 text-[11px] leading-snug ${good ? 'text-ok' : 'text-danger'}`}
    >
      <Icon size={12} aria-hidden className="mt-px shrink-0" />
      <span>
        <span className="font-semibold">{t(`usage.${window}`)}:</span> {text}
      </span>
    </span>
  )
}

/**
 * At most one forecast fits the panel: running out soonest wins, then going over,
 * then headroom (the weekly one first, it is the scarcer budget).
 */
function pickForecast(
  usage: AccountUsage,
  now: number
): { window: UsageWindowKind; forecast: Forecast } | null {
  const candidates = WINDOWS.flatMap((window) => {
    const value = forecast(usage[window], window, now)
    return value ? [{ window, forecast: value }] : []
  })
  const rank = ({ window, forecast: value }: (typeof candidates)[number]): number => {
    if (value.kind === 'runsOut') return value.inMs
    if (value.kind === 'over') return Number.MAX_SAFE_INTEGER - 2
    return Number.MAX_SAFE_INTEGER - (window === 'sevenDay' ? 1 : 0)
  }
  return candidates.sort((a, b) => rank(a) - rank(b))[0] ?? null
}
