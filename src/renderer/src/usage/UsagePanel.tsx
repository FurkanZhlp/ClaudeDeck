import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react'
import { Settings, Timer, TrendingDown, TrendingUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Account, AccountUsage, UsageWindow } from '@shared/types'
import { useCallback, useRef, useState } from 'react'
import { forecast, type Forecast, type UsageWindowKind } from '@shared/usagePace'
import { formatRelative } from '../notes/relativeTime'
import { useApp } from '../store'
import { AccountRings } from './AccountRings'
import { useRingModel, useWindowPercent } from './useRings'
import { formatDuration, formatPercent, formatResetAt } from './format'
import type { RingWindow } from './meter'
import { UsageDetails } from './UsageDetails'
import { useAccountUsage, useUsage } from './usageStore'

/** Reports older than this get a "x min ago" hint; Claude Code only reports while it runs. */
const STALE_AFTER_MS = 10 * 60_000

const WINDOWS: readonly UsageWindowKind[] = ['fiveHour', 'sevenDay']

const EASE_OUT = [0.22, 1, 0.36, 1] as const

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
          <span className="flex min-h-8 items-center pr-8">
            <AccountSummary account={account} usage={usage} />
          </span>
          {usage && <PanelForecast usage={usage} />}
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
          useApp.getState().openSettings('usage')
        }}
      >
        <Settings size={15} />
      </button>
      {account && <UsageDetails open={expanded} anchorRef={ref} onClose={close} />}
    </section>
  )
}

const PANEL_RING = 30

/** Ring, name and both windows of the selected account, in one compact row. */
function AccountSummary({
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
  const model = useRingModel(account, usage)

  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <AccountRings account={account} usage={usage} size={PANEL_RING} surface="var(--panel)" />
      <span className="block min-w-0 leading-tight">
        <span className="block truncate text-[12px] font-semibold">{account.name}</span>
        {usage ? (
          <span className="mt-0.5 flex gap-2.5 text-[11px] text-muted">
            <WindowValue kind="fiveHour" ring={model.session} window={usage.fiveHour} now={now} />
            <WindowValue kind="sevenDay" ring={model.weekly} window={usage.sevenDay} now={now} />
          </span>
        ) : (
          <span className="mt-0.5 block text-[11px] leading-snug text-muted">
            {t('usage.empty')}
          </span>
        )}
        {stale && (
          <span
            className="mt-0.5 block truncate text-[10.5px] text-muted"
            data-tooltip={t('usage.staleTooltip', { time: ago })}
          >
            {ago}
          </span>
        )}
      </span>
    </span>
  )
}

function WindowValue({
  kind,
  ring,
  window,
  now
}: {
  kind: UsageWindowKind
  ring: RingWindow
  window: UsageWindow | null
  now: number
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const percent = useWindowPercent()
  const language = i18n.language
  const longLabel = t(`usage.${kind}Long`)
  const tone =
    ring.level === 'danger' ? 'text-danger' : ring.level === 'warn' ? 'text-warn' : 'text-fg'

  let value: string
  let tooltip: string
  if (!window) {
    value = t('usage.noWindow')
    tooltip = t('usage.tooltip.empty', { window: longLabel })
  } else if (ring.reset) {
    value = t('usage.reset')
    tooltip = t('usage.tooltip.reset', { window: longLabel })
  } else {
    value = percent(ring)
    tooltip = t('usage.tooltip.active', {
      window: longLabel,
      percent: formatPercent(window.usedPercentage, language),
      at: formatResetAt(window.resetsAt, language, now),
      in: formatDuration(window.resetsAt - now, t)
    })
  }

  return (
    <span className="truncate" data-tooltip={tooltip}>
      {t(`usage.${kind}`)}{' '}
      <span className={`font-medium tabular-nums ${window && !ring.reset ? tone : ''}`}>
        {value}
      </span>
    </span>
  )
}

/** At most one forecast line under the summary; it slides in and out as the pace changes. */
function PanelForecast({ usage }: { usage: AccountUsage }): React.JSX.Element {
  const now = useUsage((s) => s.now)
  const reduced = useReducedMotion() ?? false
  const notice = pickForecast(usage, now)

  return (
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
