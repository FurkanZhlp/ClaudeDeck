import { Download, FolderOpen, ListChecks, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useOptimizeBadgeState, useOptimizeRun } from '../optimize/optimizeStore'
import { optimizeSupported } from '../platform'
import { errorCode, useApp } from '../store'
import { Button } from '../ui/Button'
import { useOnboarding } from './onboardingStore'

/** Profile actions for one account in Settings: re-import, optimize, open folder. */
export function ProfileSection({ accountId }: { accountId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const startForAccount = useOnboarding((s) => s.startForAccount)
  const run = useOptimizeRun(accountId)
  const hasRun = run !== undefined && run.status !== 'idle'
  const activity = useOptimizeBadgeState(accountId)

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
        <Button
          disabled={!optimizeSupported}
          onClick={() => startForAccount(accountId, { startAt: 'optimize' })}
        >
          {activity === 'running' ? (
            <Loader2 size={14} className="animate-spin" aria-hidden />
          ) : (
            <ListChecks size={14} />
          )}
          {hasRun ? t('optimize.open') : t('onboarding.profile.optimize')}
          {hasRun && (
            <span
              className={`ml-1 rounded-full px-1.5 py-px text-[10.5px] font-medium ${activity === 'waiting' ? 'bg-warn/15 text-warn' : 'bg-panel text-muted'}`}
            >
              {t(`optimize.status.${run.status}`)}
            </span>
          )}
        </Button>
        <Button variant="ghost" onClick={openFolder}>
          <FolderOpen size={14} />
          {t('onboarding.profile.openFolder')}
        </Button>
      </div>
      {!optimizeSupported && <p className="text-[12px] text-muted">{t('optimize.unsupported')}</p>}
    </div>
  )
}
