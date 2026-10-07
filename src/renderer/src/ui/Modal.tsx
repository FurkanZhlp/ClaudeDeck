import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  width?: string
  closeOnEscape?: boolean
  closeOnBackdrop?: boolean
}

export function Modal({
  title,
  onClose,
  children,
  width = 'max-w-lg',
  closeOnEscape = true,
  closeOnBackdrop = true
}: Props): React.JSX.Element {
  const { t } = useTranslation()

  useEffect(() => {
    if (!closeOnEscape) return
    const onKey = (event: KeyboardEvent): void => {
      // A full-window screen (sign-in, onboarding) above this modal handles its own keys.
      if (event.key === 'Escape' && !document.querySelector('[data-screen]')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, closeOnEscape])

  return (
    <div
      className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 pt-[max(1.5rem,var(--titlebar-inset-top))]"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-full w-full ${width} flex-col overflow-hidden rounded-xl border border-border bg-elevated shadow-2xl`}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            aria-label={t('common.close')}
            data-tooltip={t('common.close')}
            className="rounded p-1 text-muted hover:bg-panel hover:text-fg"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="scroll-area min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  )
}
