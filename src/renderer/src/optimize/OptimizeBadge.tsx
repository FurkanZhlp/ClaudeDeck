import { useTranslation } from 'react-i18next'
import { useOptimizeBadgeState } from './optimizeStore'
import './optimize.css'

/**
 * Small overlay on an account's rail badge: a spinning accent ring while Claude works on the
 * profile, a pulsing warning dot while a proposal waits for the user. Renders nothing otherwise.
 * The parent must be `position: relative`.
 */
export function OptimizeBadge({ accountId }: { accountId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const state = useOptimizeBadgeState(accountId)
  if (!state) return null

  if (state === 'waiting') {
    return (
      <span
        data-tooltip={t('optimize.badge.waiting')}
        data-tooltip-side="right"
        className="animate-pop-in absolute -bottom-1 -right-1 flex size-3.5 items-center justify-center rounded-full border-2 border-panel bg-warn"
      >
        <span
          aria-hidden
          className="absolute inset-0 rounded-full bg-warn motion-safe:animate-ping motion-safe:opacity-60"
        />
      </span>
    )
  }

  return (
    <span
      data-tooltip={t('optimize.badge.running')}
      data-tooltip-side="right"
      className="animate-pop-in absolute -bottom-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-panel"
    >
      <span
        aria-hidden
        className="optimize-ring size-2.5 rounded-full border-2 border-accent/25 border-t-accent"
      />
    </span>
  )
}
