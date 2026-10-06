import { AlertTriangle, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../store'
import { Button } from '../ui/Button'
import { SessionIcon, StatusDot } from '../ui/SessionIcon'

export function SessionTabs({ projectId }: { projectId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = useApp(
    useShallow((s) => (s.data?.sessions ?? []).filter((x) => x.projectId === projectId))
  )
  const projectAccountId = useApp(
    (s) => s.data?.projects.find((p) => p.id === projectId)?.accountId
  )
  const selectedSessionId = useApp((s) => s.selectedSessionId)
  const running = useApp((s) => s.running)
  const selectSession = useApp((s) => s.selectSession)
  const createSession = useApp((s) => s.createSession)
  const closeSession = useApp((s) => s.closeSession)

  const close = (id: string): void => {
    const run = running[id]
    if (run && run.exitCode === null && !window.confirm(t('session.confirmClose'))) return
    void closeSession(id)
  }

  return (
    <div className="drag flex h-11 shrink-0 items-end gap-2 border-b border-border bg-panel px-2">
      <div role="tablist" className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
        {sessions.map((session) => {
          const run = running[session.id]
          const active = session.id === selectedSessionId
          const stale = !!run && run.exitCode === null && run.accountId !== projectAccountId
          return (
            <div
              key={session.id}
              role="tab"
              tabIndex={0}
              aria-selected={active}
              className={`no-drag group flex h-8 max-w-52 shrink-0 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 ${active ? 'border-border bg-bg text-fg' : 'border-transparent text-muted hover:text-fg'}`}
              onClick={() => selectSession(session.id)}
              onKeyDown={(event) => event.key === 'Enter' && selectSession(session.id)}
            >
              <SessionIcon kind={session.kind} />
              <span className="truncate">{session.title}</span>
              <StatusDot run={run} />
              {stale && (
                <span data-tooltip={t('session.staleAccount')} className="text-warn">
                  <AlertTriangle size={12} />
                </span>
              )}
              <button
                type="button"
                aria-label={t('session.closeTab')}
                data-tooltip={t('session.closeTab')}
                className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-panel focus:opacity-100"
                onClick={(event) => {
                  event.stopPropagation()
                  close(session.id)
                }}
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="no-drag flex shrink-0 items-center gap-1 pb-1.5">
        <Button
          variant="ghost"
          data-tooltip={t('session.newClaudeHint')}
          onClick={() => void createSession('claude')}
        >
          <Plus size={14} />
          {t('session.newClaude')}
        </Button>
        <Button
          variant="ghost"
          data-tooltip={t('session.newShellHint')}
          onClick={() => void createSession('shell')}
        >
          <Plus size={14} />
          {t('session.newShell')}
        </Button>
      </div>
    </div>
  )
}
