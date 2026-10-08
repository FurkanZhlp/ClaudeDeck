import { ChevronDown, ShieldOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BYPASS_MODE, effectivePermissionMode, PERMISSION_MODES } from '@shared/permissionMode'
import type { PermissionMode } from '@shared/types'
import { useApp } from '../store'
import { useBypassConfirm } from './useBypassConfirm'

const itemClass =
  'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] hover:bg-panel focus-visible:bg-panel focus-visible:outline-none'

/**
 * Chevron next to "+ Claude": opens a Claude tab pinned to one permission mode. The choice is
 * stored on the tab, so restarting or resuming it keeps the mode.
 */
export function NewClaudeMenu({ projectId }: { projectId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const createSession = useApp((s) => s.createSession)
  const inherited = useApp((s) => {
    const data = s.data
    if (!data) return 'default'
    return effectivePermissionMode(
      data.settings.claude,
      data.projects.find((p) => p.id === projectId)
    )
  })
  const { choose, dialog } = useBypassConfirm()

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (mode: PermissionMode | null): void => {
    setOpen(false)
    if (mode === null) void createSession('claude')
    else choose(mode, (chosen) => void createSession('claude', chosen))
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('permissions.newTabMenu')}
        data-tooltip={t('permissions.newTabMenu')}
        className="no-drag rounded-md px-1 py-1.5 text-muted hover:bg-panel hover:text-fg"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t('permissions.newTabMenu')}
          className="no-drag absolute right-0 top-full z-40 mt-1 w-60 rounded-lg border border-border bg-elevated p-1 shadow-xl"
        >
          <button type="button" role="menuitem" className={itemClass} onClick={() => pick(null)}>
            {t('permissions.newTabDefault', { mode: t(`permissions.modes.${inherited}`) })}
          </button>
          <div className="my-1 border-t border-border" />
          {PERMISSION_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="menuitem"
              className={`${itemClass} ${mode === BYPASS_MODE ? 'text-danger' : ''}`}
              onClick={() => pick(mode)}
            >
              <span className="flex-1">{t(`permissions.modes.${mode}`)}</span>
              {mode === BYPASS_MODE && <ShieldOff size={13} aria-hidden />}
            </button>
          ))}
        </div>
      )}
      {dialog}
    </div>
  )
}
