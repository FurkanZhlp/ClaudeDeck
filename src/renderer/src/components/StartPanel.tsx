import { LogIn, Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Session } from '@shared/types'
import { useApp } from '../store'
import { AccountDot } from '../ui/AccountDot'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { SessionIcon } from '../ui/SessionIcon'

export function StartPanel({ session }: { session: Session }): React.JSX.Element | null {
  const { t } = useTranslation()
  const project = useApp((s) => s.data?.projects.find((p) => p.id === session.projectId))
  const account = useApp((s) => s.data?.accounts.find((a) => a.id === project?.accountId))
  const status = useApp((s) => (project ? s.statuses[project.accountId] : undefined))
  const startSession = useApp((s) => s.startSession)
  const setLoginAccount = useApp((s) => s.setLoginAccount)
  const setProjectDialog = useApp((s) => s.setProjectDialog)
  const [checked, setChecked] = useState<{ path: string; exists: boolean } | null>(null)
  const path = project?.path

  useEffect(() => {
    if (!path) return
    let alive = true
    void window.api.system.pathExists(path).then((exists) => {
      if (alive) setChecked({ path, exists })
    })
    return () => {
      alive = false
    }
  }, [path])

  if (!project || !account) return null
  const pathKnown = checked?.path === project.path
  const pathMissing = pathKnown && !checked.exists
  const signedOut = session.kind === 'claude' && typeof status === 'object' && !status.loggedIn

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-md space-y-4 rounded-xl border border-border bg-elevated p-6">
        <div className="flex items-center gap-2 text-base font-semibold">
          <SessionIcon kind={session.kind} size={18} />
          {session.title}
        </div>
        <div className="space-y-1 text-muted">
          <div className="truncate" title={project.path}>
            {project.path}
          </div>
          <div className="flex items-center gap-2">
            <AccountDot color={account.color} />
            {t('session.accountLabel', { name: account.name })}
          </div>
        </div>

        {pathMissing ? (
          <Notice tone="danger">
            <p>{t('session.pathMissing', { path: project.path })}</p>
            <Button onClick={() => setProjectDialog({ mode: 'edit', projectId: project.id })}>
              {t('sidebar.editProject')}
            </Button>
          </Notice>
        ) : signedOut ? (
          <Notice tone="warn">
            <p>{t('session.notLoggedIn', { account: account.name })}</p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => setLoginAccount(account.id)}>
                <LogIn size={14} />
                {t('session.login')}
              </Button>
              <Button onClick={() => startSession(session.id, false)}>
                {t('session.startAnyway')}
              </Button>
            </div>
          </Notice>
        ) : (
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={!pathKnown}
              onClick={() => startSession(session.id, false)}
            >
              <Play size={14} />
              {t('session.start')}
            </Button>
            {session.kind === 'claude' && (
              <Button disabled={!pathKnown} onClick={() => startSession(session.id, true)}>
                {t('session.resume')}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
