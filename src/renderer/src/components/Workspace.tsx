import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { SessionPane } from './SessionPane'
import { SessionTabs } from './SessionTabs'
import { Welcome } from './Welcome'

export function Workspace(): React.JSX.Element {
  const { t } = useTranslation()
  const projectId = useApp((s) => s.selectedProjectId)
  const sessionId = useApp((s) => s.selectedSessionId)
  const projectExists = useApp((s) => !!s.data?.projects.some((p) => p.id === s.selectedProjectId))

  if (!projectId || !projectExists) return <Welcome />

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SessionTabs projectId={projectId} />
      {sessionId ? (
        <SessionPane key={sessionId} sessionId={sessionId} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-muted">
          {t('session.noSessions')}
        </div>
      )}
    </div>
  )
}
