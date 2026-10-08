import { useTranslation } from 'react-i18next'
import { PERMISSION_MODES } from '@shared/permissionMode'
import type { PermissionMode } from '@shared/types'
import { inputClass } from '../ui/styles'

export const INHERIT = 'inherit'
type Value = PermissionMode | typeof INHERIT

/** Native select of permission modes; `inheritLabel` adds an "inherit" option first. */
export function PermissionModeSelect<T extends Value>({
  value,
  onChange,
  label,
  inheritLabel
}: {
  value: T
  onChange: (value: T) => void
  label: string
  inheritLabel?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <select
      aria-label={label}
      className={`${inputClass} max-w-52`}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {inheritLabel && <option value={INHERIT}>{inheritLabel}</option>}
      {PERMISSION_MODES.map((mode) => (
        <option key={mode} value={mode}>
          {t(`permissions.modes.${mode}`)}
        </option>
      ))}
    </select>
  )
}
