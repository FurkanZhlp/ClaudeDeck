import { ShieldOff } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

/** Explains what bypass permissions allows before the user turns it on. */
export function BypassConfirmDialog({
  onCancel,
  onAccept
}: {
  onCancel: () => void
  onAccept: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // Opened above another dialog: Escape must close only this one, so it is caught in the
  // capture phase before the outer dialog's window listener sees it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  return (
    <Modal title={t('permissions.confirm.title')} onClose={onCancel} closeOnEscape={false}>
      <div className="space-y-3">
        <div className="flex gap-2.5">
          <ShieldOff size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden />
          <p>{t('permissions.confirm.risk')}</p>
        </div>
        <p className="text-muted">{t('permissions.confirm.trust')}</p>
        <p className="text-[12px] leading-snug text-muted">{t('permissions.confirm.claude')}</p>
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onCancel} autoFocus>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={onAccept}>
            {t('permissions.confirm.accept')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
