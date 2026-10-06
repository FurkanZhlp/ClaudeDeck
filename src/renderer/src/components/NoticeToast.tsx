import { Info, X } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'

export function NoticeToast(): React.JSX.Element | null {
  const { t } = useTranslation()
  const notice = useApp((s) => s.notice)
  const setNotice = useApp((s) => s.setNotice)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 8000)
    return () => clearTimeout(timer)
  }, [notice, setNotice])

  if (!notice) return null
  return (
    <div
      role="status"
      className="animate-fade-up fixed bottom-4 left-1/2 z-[90] flex max-w-md -translate-x-1/2 items-start gap-3 rounded-lg border border-border bg-elevated p-3 shadow-xl"
    >
      <Info size={16} className="mt-0.5 shrink-0 text-accent" />
      <span className="flex-1">{notice}</span>
      <button
        type="button"
        aria-label={t('common.close')}
        data-tooltip={t('common.close')}
        className="text-muted hover:text-fg"
        onClick={() => setNotice(null)}
      >
        <X size={14} />
      </button>
    </div>
  )
}
