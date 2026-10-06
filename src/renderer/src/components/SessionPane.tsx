import { RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { TerminalView } from '../terminal/TerminalView'
import * as pool from '../terminal/terminalPool'
import { Button } from '../ui/Button'
import { StartPanel } from './StartPanel'

export function SessionPane({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const session = useApp((s) => s.data?.sessions.find((x) => x.id === sessionId))
  const run = useApp((s) => s.running[sessionId])
  const startSession = useApp((s) => s.startSession)
  const spawn = useApp((s) => s.spawn)
  const closeSession = useApp((s) => s.closeSession)

  if (!session) return null
  if (!run) return <StartPanel session={session} />

  const onReady = (cols: number, rows: number): void => {
    const pending = pool.takePending(session.id)
    if (pending) void spawn(session.id, pending.resume, cols, rows)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-[#141413]">
      <div className="min-h-0 flex-1">
        <TerminalView key={run.runId} id={session.id} onReady={onReady} />
      </div>
      {run.exitCode !== null && (
        <div className="flex items-center gap-2 border-t border-border bg-elevated px-4 py-2.5">
          <span className="flex-1 text-muted">{t('session.exited', { code: run.exitCode })}</span>
          <Button variant="primary" onClick={() => startSession(session.id, false)}>
            <RotateCw size={14} />
            {t('session.restart')}
          </Button>
          {session.kind === 'claude' && (
            <Button onClick={() => startSession(session.id, true)}>{t('session.resume')}</Button>
          )}
          <Button variant="ghost" onClick={() => void closeSession(session.id)}>
            {t('session.close')}
          </Button>
        </div>
      )}
    </div>
  )
}
