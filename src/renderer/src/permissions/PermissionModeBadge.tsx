import { ShieldOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { BYPASS_MODE } from '@shared/permissionMode'
import type { PermissionMode } from '@shared/types'

/**
 * Tab marker for the mode a running Claude tab started in: a red shield for bypass, a short
 * muted label for the other explicit modes, nothing for "Claude settings".
 */
export function PermissionModeBadge({
  mode
}: {
  mode: PermissionMode | null | undefined
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!mode || mode === 'default') return null
  if (mode === BYPASS_MODE) {
    return (
      <span
        role="img"
        aria-label={t('permissions.tabBypass')}
        data-tooltip={t('permissions.tabBypass')}
        className="text-danger"
      >
        <ShieldOff size={12} />
      </span>
    )
  }
  const tooltip = t('permissions.tabMode', { mode: t(`permissions.modes.${mode}`) })
  return (
    <span
      aria-label={tooltip}
      data-tooltip={tooltip}
      className="shrink-0 rounded bg-fg/[0.06] px-1 text-[10px] leading-4 text-muted"
    >
      {t(`permissions.short.${mode}`)}
    </span>
  )
}
