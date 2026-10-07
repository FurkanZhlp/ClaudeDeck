import { useTranslation } from 'react-i18next'
import type { Account, AccountUsage } from '@shared/types'
import type { UsageWindowKind } from '@shared/usagePace'
import { UsageRings } from './charts'
import { useUsageDisplay } from './display'
import { formatPercent } from './format'
import type { RingWindow } from './meter'
import { elapsedFraction } from './ring'
import { useRingModel, useWindowPercent } from './useRings'
import { useUsage } from './usageStore'

/** The account's rings with an accessible summary; `center` shows the critical value inside. */
export function AccountRings({
  account,
  usage,
  size,
  center = false,
  surface
}: {
  account: Account
  usage: AccountUsage | undefined
  size: number
  center?: boolean
  surface?: string
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const now = useUsage((s) => s.now)
  const display = useUsageDisplay()
  const model = useRingModel(account, usage)
  const percent = useWindowPercent()
  const legend = t(display === 'used' ? 'usage.ring.legendUsed' : 'usage.ring.legendRemaining')

  const describe = (window: RingWindow): string => {
    const name = t(`usage.${window.kind}Long`)
    if (!window.active) return t('usage.ring.windowEmpty', { window: name })
    if (window.reset) return t('usage.ring.windowReset', { window: name })
    const value = t(display === 'used' ? 'usage.details.used' : 'usage.details.left', {
      percent: percent(window)
    })
    const source = usage?.[window.kind] ?? null
    const elapsed = elapsedFraction(source, window.kind, now) ?? 0
    return t('usage.ring.window', {
      window: name,
      value,
      elapsed: formatPercent(elapsed * 100, i18n.language)
    })
  }
  const label = `${account.name}. ${describe(model.session)}. ${describe(model.weekly)}.`

  return (
    <UsageRings
      size={size}
      session={model.session}
      weekly={model.weekly}
      accountColor={account.color}
      label={label}
      tooltip={center ? legend : undefined}
      surface={surface}
    >
      {center &&
        (model.critical ? (
          <>
            <span className="text-[19px] font-semibold leading-none tracking-tight tabular-nums">
              {percent(model.critical)}
            </span>
            <span className="mt-1 text-[9px] leading-none text-muted">
              {t(display === 'used' ? 'usage.ring.used' : 'usage.ring.left')}
            </span>
          </>
        ) : (
          <span className="text-[10px] text-muted">{t('usage.noWindow')}</span>
        ))}
    </UsageRings>
  )
}

/** Tiny key glyph telling the inner (session) ring from the outer (weekly) one. */
export function RingKey({
  kind,
  color
}: {
  kind: UsageWindowKind
  color: string
}): React.JSX.Element {
  const outer = kind === 'sevenDay'
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden className="shrink-0">
      <circle
        cx={5}
        cy={5}
        r={4}
        fill="none"
        strokeWidth={1.6}
        stroke={outer ? color : 'currentColor'}
        opacity={outer ? 1 : 0.3}
      />
      <circle
        cx={5}
        cy={5}
        r={1.7}
        fill={outer ? 'currentColor' : color}
        opacity={outer ? 0.3 : 1}
      />
    </svg>
  )
}
