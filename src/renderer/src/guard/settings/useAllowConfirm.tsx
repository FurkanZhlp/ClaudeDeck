import { useCallback, useState } from 'react'
import type { GuardCategoryId } from '@shared/types'
import { AllowConfirmDialog } from './AllowConfirmDialog'

/**
 * Asks before something in a confirm-first category (disk, sensitive) is set to allow; other
 * changes apply at once. Render `dialog` next to the controls that call `confirm`.
 */
export function useAllowConfirm(): {
  confirm: (category: GuardCategoryId, needed: boolean, apply: () => void) => void
  dialog: React.JSX.Element | null
} {
  const [pending, setPending] = useState<{ category: GuardCategoryId; apply: () => void } | null>(
    null
  )
  const confirm = useCallback((category: GuardCategoryId, needed: boolean, apply: () => void) => {
    if (needed) setPending({ category, apply })
    else apply()
  }, [])
  const cancel = useCallback(() => setPending(null), [])
  const dialog = pending ? (
    <AllowConfirmDialog
      category={pending.category}
      onCancel={cancel}
      onAccept={() => {
        setPending(null)
        pending.apply()
      }}
    />
  ) : null
  return { confirm, dialog }
}
