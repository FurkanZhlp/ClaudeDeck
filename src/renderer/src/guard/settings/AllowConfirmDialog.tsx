import { ShieldOff } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { GuardCategoryId } from '@shared/types'
import { Button } from '../../ui/Button'
import { Modal } from '../../ui/Modal'
import { guardCategoryLabel } from '../guardStore'

/** Explains what allowing a protective category means before it is switched to allow. */
export function AllowConfirmDialog({
  category,
  onCancel,
  onAccept
}: {
  category: GuardCategoryId
  onCancel: () => void
  onAccept: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // Opened above the project dialog too: Escape closes only this one (capture phase), as in
  // the bypass confirmation.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  const name = guardCategoryLabel(category)
  return (
    <Modal
      title={t('guard.confirm.title', { category: name })}
      onClose={onCancel}
      closeOnEscape={false}
    >
      <div className="space-y-3">
        <div className="flex gap-2.5">
          <ShieldOff size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden />
          <p>{t(`guard.confirm.risk.${category}`)}</p>
        </div>
        <p className="text-muted">{t('guard.confirm.advice')}</p>
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onCancel} autoFocus>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={onAccept}>
            {t('guard.confirm.accept')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
