import { X } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'

export function ErrorToast(): React.JSX.Element | null {
  const { t } = useTranslation()
  const error = useApp((s) => s.error)
  const setError = useApp((s) => s.setError)

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 6000)
    return () => clearTimeout(timer)
  }, [error, setError])

  if (!error) return null
  return (
    <div
      role="alert"
      className="fixed bottom-4 right-4 z-[60] flex max-w-sm items-start gap-3 rounded-lg border border-border bg-elevated p-3 shadow-xl"
    >
      <span className="flex-1 text-danger">
        {t(`errors.${error}`, { defaultValue: t('errors.UNKNOWN') })}
      </span>
      <button
        type="button"
        aria-label={t('common.close')}
        className="text-muted hover:text-fg"
        onClick={() => setError(null)}
      >
        <X size={14} />
      </button>
    </div>
  )
}
