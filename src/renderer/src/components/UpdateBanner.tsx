import { Download, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { Button } from '../ui/Button'

export function UpdateBanner(): React.JSX.Element | null {
  const { t } = useTranslation()
  const update = useApp((s) => s.update)
  const dismissUpdate = useApp((s) => s.dismissUpdate)
  if (!update?.available || !update.latestVersion) return null

  return (
    <div className="flex items-center gap-3 border-b border-border bg-elevated py-2 pl-4 pr-[calc(var(--titlebar-inset-right)_+_1rem)]">
      <span className="flex-1">
        {t('update.available', { version: update.latestVersion })}
        <span className="ml-2 text-muted">
          {t('update.current', { version: update.currentVersion })}
        </span>
      </span>
      <Button variant="primary" onClick={() => void window.api.update.open()}>
        <Download size={14} />
        {t('update.download')}
      </Button>
      <button
        type="button"
        aria-label={t('common.close')}
        data-tooltip={t('common.close')}
        className="rounded p-1 text-muted hover:bg-panel hover:text-fg"
        onClick={dismissUpdate}
      >
        <X size={14} />
      </button>
    </div>
  )
}
