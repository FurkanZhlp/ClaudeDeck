import { useTranslation } from 'react-i18next'
import { AgentsPanel } from '../agents/AgentsPanel'
import { NotesPanel } from '../notes/NotesPanel'
import { useApp } from '../store'
import { useSidePanel } from '../ui/sidePanelStore'
import { AccountEmpty } from './AccountEmpty'
import { SessionPane } from './SessionPane'
import { SessionTabs } from './SessionTabs'
import { Welcome } from './Welcome'

export function Workspace(): React.JSX.Element {
  const { t } = useTranslation()
  const projectId = useApp((s) => s.selectedProjectId)
  const sessionId = useApp((s) => s.selectedSessionId)
  const projectExists = useApp((s) => !!s.data?.projects.some((p) => p.id === s.selectedProjectId))
  const account = useApp((s) => s.data?.accounts.find((a) => a.id === s.selectedAccountId))
  const sessionKind = useApp((s) => s.data?.sessions.find((x) => x.id === sessionId)?.kind)
  const sidePanel = useSidePanel((s) => s.panel)

  if (!account) return <Welcome />
  if (!projectId || !projectExists) return <AccountEmpty account={account} />

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SessionTabs projectId={projectId} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {sessionId ? (
            <SessionPane key={sessionId} sessionId={sessionId} />
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-muted">
              {t('session.noSessions')}
            </div>
          )}
        </div>
        {sidePanel === 'notes' && <NotesPanel key={projectId} projectId={projectId} />}
        {/* Agents belong to a Claude tab; on a shell tab the panel waits until one is selected. */}
        {sidePanel === 'agents' && sessionId && sessionKind === 'claude' && (
          <AgentsPanel key={sessionId} sessionId={sessionId} />
        )}
      </div>
    </div>
  )
}
