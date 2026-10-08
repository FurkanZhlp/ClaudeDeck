import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { GuardSettingsPatch } from '@shared/types'
import { guardHooksOff } from '../../guard/guardModel'
import { useGuard } from '../../guard/guardStore'
import { ActivityLog } from '../../guard/settings/ActivityLog'
import { CategoryList } from '../../guard/settings/CategoryList'
import { GuardCustomRules } from '../../guard/settings/GuardCustomRules'
import { GuardTryCommand } from '../../guard/settings/GuardTryCommand'
import { subTitleClass } from '../../guard/settings/categoryIcons'
import { useApp } from '../../store'
import { useTestQueue } from '../../testQueue/testQueueStore'
import { Notice } from '../../ui/Notice'
import { Switch } from '../../ui/Switch'

/**
 * Settings > Command guard: the switch (it adds the ClaudeDeck hook to every account's Claude
 * settings), category and rule actions, custom rules, a command tester and the activity log.
 * Saved on change, like the other sections.
 */
export function GuardSection(): React.JSX.Element | null {
  const { t } = useTranslation()
  const settings = useApp((s) => s.data?.settings.guard)
  const saveSettings = useGuard((s) => s.saveSettings)
  if (!settings) return null

  const save = async (patch: GuardSettingsPatch): Promise<string | null> => {
    const code = await saveSettings(patch)
    if (code) useApp.getState().setError(code)
    return code
  }

  return (
    <div className="space-y-3">
      <Switch
        label={t('guard.settings.enabled')}
        hint={t('guard.settings.enabledHint')}
        checked={settings.enabled}
        onChange={(enabled) =>
          void save({ enabled }).then((code) => {
            // The hook status says whether the guard is on; it changes with the switch.
            if (!code) void useTestQueue.getState().loadHookStatus()
          })
        }
      />
      {settings.enabled && (
        <>
          <HookProblems />
          <h4 className={subTitleClass}>{t('guard.settings.categories')}</h4>
          <CategoryList settings={settings} save={(patch) => void save(patch)} />

          <h4 className={subTitleClass}>{t('guard.custom.title')}</h4>
          <GuardCustomRules
            rules={settings.customRules}
            onSave={(customRules) => saveSettings({ customRules })}
          />

          <h4 className={subTitleClass}>{t('guard.try.title')}</h4>
          <GuardTryCommand />

          <h4 className={subTitleClass}>{t('guard.log.title')}</h4>
          <ActivityLog />
        </>
      )}
    </div>
  )
}

/**
 * Where the hook cannot run, the guard cannot either: Windows accounts without Git Bash get no
 * hook, managed settings may allow only managed hooks, and a project may disable all hooks.
 */
function HookProblems(): React.JSX.Element | null {
  const { t } = useTranslation()
  const status = useTestQueue((s) => s.hookStatus)
  const projects = useApp((s) => s.data?.projects) ?? []

  useEffect(() => {
    void useTestQueue.getState().loadHookStatus()
  }, [])

  if (!status) return null
  const noGitBash = status.accounts.some((a) => a.problem === 'noGitBash')
  const disabled = guardHooksOff(status)
    ? projects.filter((p) => status.hooksDisabledProjectIds.includes(p.id))
    : []
  if (!status.managedHooksOnly && !noGitBash && disabled.length === 0) return null
  return (
    <Notice tone="warn">
      {status.managedHooksOnly ? (
        <p>{t('guard.settings.managedOnly')}</p>
      ) : (
        <>
          {noGitBash && <p>{t('guard.settings.noGitBash')}</p>}
          {disabled.length > 0 && (
            <p>
              {t('guard.settings.projectsHooksDisabled', {
                projects: disabled.map((p) => p.name).join(', ')
              })}
            </p>
          )}
        </>
      )}
    </Notice>
  )
}
