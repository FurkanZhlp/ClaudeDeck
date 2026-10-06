import { FolderPlus, LogIn } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Account } from '@shared/types'
import { useApp } from '../store'
import { Button } from '../ui/Button'
import { tint } from '../ui/styles'

export function AccountEmpty({ account }: { account: Account }): React.JSX.Element {
  const { t } = useTranslation()
  const status = useApp((s) => s.statuses[account.id])
  const setProjectDialog = useApp((s) => s.setProjectDialog)
  const setLoginAccount = useApp((s) => s.setLoginAccount)
  const signedOut = typeof status === 'object' && !status.loggedIn

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="drag h-11 shrink-0" />
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="animate-fade-up w-full max-w-sm text-center">
          <span
            aria-hidden
            className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl"
            style={{ background: tint(account.color, 16), color: account.color }}
          >
            <FolderPlus size={22} />
          </span>
          <h2 className="text-base font-semibold">
            {t('workspace.emptyTitle', { name: account.name })}
          </h2>
          <p className="mt-1.5 text-muted">{t('workspace.emptyHint')}</p>
          <div className="mt-5 flex justify-center gap-2">
            <Button variant="primary" onClick={() => setProjectDialog({ mode: 'create' })}>
              <FolderPlus size={14} />
              {t('welcome.newProject')}
            </Button>
            {signedOut && (
              <Button onClick={() => setLoginAccount(account.id)}>
                <LogIn size={14} />
                {t('session.login')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
