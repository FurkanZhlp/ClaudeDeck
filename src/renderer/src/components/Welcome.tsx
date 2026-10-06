import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { Button } from '../ui/Button'

export function Welcome(): React.JSX.Element {
  const { t } = useTranslation()
  const setSettingsOpen = useApp((s) => s.setSettingsOpen)
  const setProjectDialog = useApp((s) => s.setProjectDialog)
  const hasAccounts = useApp((s) => (s.data?.accounts.length ?? 0) > 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="drag h-11 shrink-0" />
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-md space-y-5">
          <h1 className="text-xl font-semibold">{t('welcome.title')}</h1>
          <ol className="list-decimal space-y-2 pl-5 text-muted">
            <li>{t('welcome.step1')}</li>
            <li>{t('welcome.step2')}</li>
            <li>{t('welcome.step3')}</li>
          </ol>
          <div className="flex gap-2">
            <Button
              variant={hasAccounts ? 'secondary' : 'primary'}
              onClick={() => setSettingsOpen(true)}
            >
              {t('welcome.addAccount')}
            </Button>
            <Button
              variant={hasAccounts ? 'primary' : 'secondary'}
              onClick={() => setProjectDialog({ mode: 'create' })}
            >
              {t('welcome.newProject')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
