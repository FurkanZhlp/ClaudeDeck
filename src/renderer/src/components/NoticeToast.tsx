import { Info, ShieldAlert, X } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'

export function NoticeToast(): React.JSX.Element | null {
  const { t } = useTranslation()
  const notice = useApp((s) => s.notice)
  const setNotice = useApp((s) => s.setNotice)

  // A merged notice is a new object, so it restarts the timer.
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 8000)
    return () => clearTimeout(timer)
  }, [notice, setNotice])

  if (!notice) return null
  const Icon = notice.source === 'guard' ? ShieldAlert : Info
  return (
    <div
      role="status"
      className="animate-fade-up fixed bottom-4 left-1/2 z-[90] flex max-w-md -translate-x-1/2 items-start gap-3 rounded-lg border border-border bg-elevated p-3 shadow-xl"
    >
      <Icon
        size={16}
        aria-hidden
        className={`mt-0.5 shrink-0 ${notice.source === 'guard' ? 'text-danger' : 'text-accent'}`}
      />
      <span className="min-w-0 flex-1 space-y-1">
        <span className="block break-words">{notice.message}</span>
        {notice.action && (
          <button
            type="button"
            className="rounded text-[12px] font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() => {
              notice.action?.run()
              setNotice(null)
            }}
          >
            {notice.action.label}
          </button>
        )}
      </span>
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
