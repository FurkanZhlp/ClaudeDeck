import { useTranslation } from 'react-i18next'
import type { GuardAction } from '@shared/types'

const BADGE_TONES: Record<GuardAction, string> = {
  allow: 'bg-ok/12 text-ok',
  ask: 'bg-warn/15 text-warn',
  deny: 'bg-danger/12 text-danger'
}

/** Small coloured label for an action (log rows, try-a-command result). */
export function ActionBadge({ action }: { action: GuardAction }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-px text-[10.5px] font-semibold ${BADGE_TONES[action]}`}
    >
      {t(`guard.actions.${action}`)}
    </span>
  )
}
