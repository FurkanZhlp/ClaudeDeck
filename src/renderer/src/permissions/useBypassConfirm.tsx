import { useCallback, useState } from 'react'
import { BYPASS_MODE } from '@shared/permissionMode'
import type { PermissionMode } from '@shared/types'
import { BypassConfirmDialog } from './BypassConfirmDialog'

/**
 * Asks before bypass permissions is chosen (globally, for a project or for one tab); every
 * other mode is applied at once. Render `dialog` next to the control that calls `choose`.
 */
export function useBypassConfirm<T extends string = PermissionMode>(): {
  choose: (mode: T, apply: (mode: T) => void) => void
  dialog: React.JSX.Element | null
} {
  const [pending, setPending] = useState<(() => void) | null>(null)
  const choose = useCallback((mode: T, apply: (mode: T) => void) => {
    if (mode === BYPASS_MODE) setPending(() => () => apply(mode))
    else apply(mode)
  }, [])
  const dialog = pending ? (
    <BypassConfirmDialog
      onCancel={() => setPending(null)}
      onAccept={() => {
        setPending(null)
        pending()
      }}
    />
  ) : null
  return { choose, dialog }
}
