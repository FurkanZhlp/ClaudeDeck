import { Download, FolderOpen, ListChecks } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { errorCode, useApp } from '../store'
import { Button } from '../ui/Button'
import { useOnboarding } from './onboardingStore'

/** Profile actions for one account in Settings: re-import, optimize, open folder. */
export function ProfileSection({ accountId }: { accountId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const startForAccount = useOnboarding((s) => s.startForAccount)

  const openFolder = (): void => {
    window.api.profile
      .openFolder(accountId)
      .catch((error) => useApp.getState().setError(errorCode(error)))
  }

  return (
    <div className="space-y-2">
      <div>
        <div className="text-[12px] font-medium">{t('onboarding.profile.title')}</div>
        <p className="text-[12px] text-muted">{t('onboarding.profile.hint')}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => startForAccount(accountId)}>
          <Download size={14} />
          {t('onboarding.profile.import')}
        </Button>
        <Button onClick={() => startForAccount(accountId, { startAt: 'optimize' })}>
          <ListChecks size={14} />
          {t('onboarding.profile.optimize')}
        </Button>
        <Button variant="ghost" onClick={openFolder}>
          <FolderOpen size={14} />
          {t('onboarding.profile.openFolder')}
        </Button>
      </div>
    </div>
  )
}
