import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react'
import { Settings, Timer, TrendingDown, TrendingUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Account, AccountUsage, UsageWindow } from '@shared/types'
import {
  PERIOD_MS,
  evaluatePace,
  forecast,
  isReset,
  usageLevel,
  type Forecast,
  type UsageLevel,
  type UsageWindowKind
} from '@shared/usagePace'
import { formatRelative } from '../notes/relativeTime'
import { useApp } from '../store'
import { formatDuration, formatPercent, formatResetAt } from './format'
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

const LEVEL_COLOR: Record<UsageLevel, string> = {
  calm: 'var(--accent)',
  warn: 'var(--warn)',
  danger: 'var(--danger)'
}

/** Discord style user panel at the bottom of the sidebar, focused on plan usage. */
export function UsagePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const account = useApp((s) => s.data?.accounts.find((a) => a.id === s.selectedAccountId))
  const usage = useAccountUsage(account?.id ?? null)

  return (
    <section
      aria-label={t('usage.title')}
      className="border-t border-border bg-fg/[0.035] px-2.5 pb-2.5 pt-2"
    >
      <div className="flex items-center gap-2">
        {account && <AccountIdentity account={account} usage={usage} />}
        <button
          type="button"
          aria-label={t('sidebar.settings')}
          data-tooltip={t('sidebar.settings')}
          className="no-drag ml-auto rounded-md p-1.5 text-muted transition-colors hover:bg-elevated hover:text-fg"
          onClick={() => useApp.getState().setSettingsOpen(true)}
        >
          <Settings size={15} />
        </button>
      </div>
      {account &&
        (usage ? (
          <UsageDetails usage={usage} />
        ) : (
          <p className="mt-1.5 text-[11px] leading-snug text-muted">{t('usage.empty')}</p>
        ))}
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
    <div className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded-lg text-[12px] font-semibold text-white"
        style={{ background: account.color }}
      >
        {account.name.trim().charAt(0).toLocaleUpperCase()}
      </span>
      <div className="min-w-0 leading-tight">
        <div className="truncate text-[12px] font-semibold">{account.name}</div>
        {stale && (
          <div
            className="truncate text-[10.5px] text-muted"
            data-tooltip={t('usage.staleTooltip', { time: ago })}
          >
            {ago}
          </div>
        )}
      </div>
    </div>
  )
}

function UsageDetails({ usage }: { usage: AccountUsage }): React.JSX.Element {
  const now = useUsage((s) => s.now)
  const reduced = useReducedMotion() ?? false
  const notice = pickForecast(usage, now)

  return (
    <>
      <div className="mt-2 space-y-1.5">
        {WINDOWS.map((kind) => (
          <Meter key={kind} kind={kind} window={usage[kind]} now={now} />
        ))}
      </div>
      <AnimatePresence initial={false}>
        {notice && (
          <motion.div
            key={`${notice.window}:${notice.forecast.kind}`}
            variants={forecastVariants(reduced)}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            <ForecastLine window={notice.window} forecast={notice.forecast} />
          </motion.div>
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
  const language = i18n.language
  const label = t(`usage.${kind}`)
  const longLabel = t(`usage.${kind}Long`)
  const reset = window !== null && isReset(window, now)
  const used = window && !reset ? Math.min(100, Math.max(0, window.usedPercentage)) : 0
  const pace =
    window && !reset
      ? evaluatePace({ used, resetsAt: window.resetsAt, periodMs: PERIOD_MS[kind], now })
      : null
  const level = usageLevel(used, pace)
  const percent = formatPercent(used, language)

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
    <div data-tooltip={tooltip}>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="truncate tabular-nums">
          {window && !reset && <span className="font-medium text-fg">{percent}</span>}
          <span className="text-muted">
            {window && !reset ? ' · ' : ''}
            {detail}
          </span>
        </span>
      </div>
      <div
        role="meter"
        aria-label={longLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
        aria-valuetext={window && !reset ? `${percent}, ${detail}` : detail}
        className="mt-1 h-1 overflow-hidden rounded-full bg-fg/10"
      >
        <motion.div
          className="h-full origin-left rounded-full transition-colors duration-300"
          style={{ background: LEVEL_COLOR[level] }}
          initial={false}
          animate={{ scaleX: used / 100 }}
          transition={reduced ? { duration: 0 } : { duration: FILL_S, ease: EASE_OUT }}
        />
      </div>
    </div>
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
    <p
      role="status"
      data-tooltip={tooltip}
      className={`mt-2 flex items-start gap-1.5 text-[11px] leading-snug ${good ? 'text-ok' : 'text-danger'}`}
    >
      <Icon size={12} aria-hidden className="mt-px shrink-0" />
      <span>
        <span className="font-semibold">{t(`usage.${window}`)}:</span> {text}
      </span>
    </p>
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
