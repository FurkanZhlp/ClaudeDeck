import { Folder, Pencil, Plus, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { AccountDot } from '../ui/AccountDot'
import { Button } from '../ui/Button'
import { SessionIcon, StatusDot } from '../ui/SessionIcon'
import { sectionTitleClass } from '../ui/styles'

export function Sidebar(): React.JSX.Element | null {
  const { t } = useTranslation()
  const data = useApp((s) => s.data)
  const selectedProjectId = useApp((s) => s.selectedProjectId)
  const selectedSessionId = useApp((s) => s.selectedSessionId)
  const running = useApp((s) => s.running)
  const selectProject = useApp((s) => s.selectProject)
  const selectSession = useApp((s) => s.selectSession)
  const setProjectDialog = useApp((s) => s.setProjectDialog)
  const setSettingsOpen = useApp((s) => s.setSettingsOpen)
  if (!data) return null

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-panel">
      <div className="drag h-11 shrink-0" />
      <div className="flex items-center justify-between px-3 pb-2">
        <span className={sectionTitleClass}>{t('sidebar.projects')}</span>
        <button
          type="button"
          aria-label={t('sidebar.newProject')}
          title={t('sidebar.newProject')}
          className="no-drag rounded p-1 text-muted hover:bg-elevated hover:text-fg"
          onClick={() => setProjectDialog({ mode: 'create' })}
        >
          <Plus size={14} />
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {data.projects.length === 0 && (
          <p className="px-2 py-3 text-muted">{t('sidebar.noProjects')}</p>
        )}
        {data.projects.map((project) => {
          const account = data.accounts.find((a) => a.id === project.accountId)
          const sessions = data.sessions.filter((s) => s.projectId === project.id)
          const active = project.id === selectedProjectId
          return (
            <div key={project.id} className="mb-1">
              <div
                role="button"
                tabIndex={0}
                className={`group flex items-center gap-2 rounded-md px-2 py-1.5 ${active ? 'bg-elevated' : 'hover:bg-elevated/60'}`}
                onClick={() => selectProject(project.id)}
                onKeyDown={(event) => event.key === 'Enter' && selectProject(project.id)}
              >
                <Folder size={14} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{project.name}</div>
                  {account && (
                    <div className="flex items-center gap-1.5 text-[11px] text-muted">
                      <AccountDot color={account.color} size={6} />
                      <span className="truncate">{account.name}</span>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={t('sidebar.editProject')}
                  title={t('sidebar.editProject')}
                  className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-fg focus:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation()
                    setProjectDialog({ mode: 'edit', projectId: project.id })
                  }}
                >
                  <Pencil size={12} />
                </button>
              </div>
              {sessions.length > 0 && (
                <ul className="ml-4 mt-0.5 border-l border-border pl-2">
                  {sessions.map((session) => (
                    <li key={session.id}>
                      <button
                        type="button"
                        className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left ${session.id === selectedSessionId ? 'text-fg' : 'text-muted hover:text-fg'}`}
                        onClick={() => selectSession(session.id)}
                      >
                        <SessionIcon kind={session.kind} size={12} />
                        <span className="min-w-0 flex-1 truncate">{session.title}</span>
                        <StatusDot run={running[session.id]} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </nav>

      <div className="border-t border-border p-2">
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={14} />
          {t('sidebar.settings')}
        </Button>
      </div>
    </aside>
  )
}
