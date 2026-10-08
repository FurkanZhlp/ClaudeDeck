import { Hourglass, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { guardHooksOff } from '../guard/guardModel'
import { useApp } from '../store'
import { waitingPosition } from './queueModel'
import { useTestQueue } from './testQueueStore'

/**
 * Small marker for a Claude tab: an hourglass with the queue position while one of its test
 * runs waits, or a warning when hooks are disabled for its project (neither the queue nor the
 * command guard can see it). Renders nothing while both features are off.
 */
export function TestQueueTabBadge({
  sessionId,
  projectId
}: {
  sessionId: string
  projectId: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const enabled = useApp((s) => s.data?.settings.testQueue.enabled ?? false)
  const position = useTestQueue((s) => waitingPosition(s.snapshot, sessionId))
  const hooksOff = useTestQueue(
    (s) =>
      !!s.hookStatus &&
      (s.hookStatus.managedHooksOnly || s.hookStatus.hooksDisabledProjectIds.includes(projectId))
  )
  const guardOff = useTestQueue((s) => guardHooksOff(s.hookStatus, projectId))
  const queueOff = enabled && hooksOff

  if (queueOff || guardOff) {
    const label =
      queueOff && guardOff
        ? t('guard.badge.hooksDisabledBoth')
        : guardOff
          ? t('guard.badge.hooksDisabled')
          : t('testQueue.badge.hooksDisabled')
    return (
      <span
        role="img"
        aria-label={label}
        data-tooltip={label}
        className="flex shrink-0 items-center text-warn"
      >
        <TriangleAlert size={11} aria-hidden />
      </span>
    )
  }
  if (!enabled || position === null) return null
  const label = t('testQueue.badge.waiting', { position })
  return (
    <span
      role="img"
      aria-label={label}
      data-tooltip={label}
      className="flex shrink-0 items-center gap-0.5 rounded bg-warn/15 px-1 text-[10px] font-semibold tabular-nums text-warn"
    >
      <Hourglass size={10} aria-hidden />
      {position}
    </span>
  )
}
