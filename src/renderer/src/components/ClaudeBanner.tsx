import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'

export function ClaudeBanner(): React.JSX.Element | null {
  const { t } = useTranslation()
  const available = useApp((s) => s.claudeAvailable)
  if (available !== false) return null
  return (
    <div className="flex items-center gap-2 border-b border-border bg-elevated px-4 py-2 text-warn">
      <AlertTriangle size={14} className="shrink-0" />
      <span className="select-text">{t('errors.CLAUDE_NOT_FOUND')}</span>
    </div>
  )
}
