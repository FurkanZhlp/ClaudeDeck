import { useTranslation } from 'react-i18next'
import type { TrayMetric, UsageDisplay } from '@shared/types'
import { isWindows } from '../../platform'
import { useApp } from '../../store'
import { Segmented } from '../../ui/Segmented'
import { inputClass } from '../../ui/styles'
import { Switch } from '../../ui/Switch'
import { SettingRow } from '../SettingRow'

const TRAY_AUTO = 'auto'
const TRAY_SELECTED = 'selected'

/**
 * Settings > Usage: display mode and the macOS menu bar item. Windows has no tray yet, so its
 * menu bar options are hidden there.
 */
export function UsageSection(): React.JSX.Element | null {
  const { t } = useTranslation()
  const usage = useApp((s) => s.data?.settings.usage)
  const setUsageSettings = useApp((s) => s.setUsageSettings)
  if (!usage) return null

  return (
    <div className="space-y-3">
      <SettingRow settingKey="usage.display" label={t('settings.usageDisplay')}>
        <Segmented<UsageDisplay>
          label={t('settings.usageDisplay')}
          value={usage.display}
          options={[
            { value: 'used', label: t('settings.displayUsed') },
            { value: 'remaining', label: t('settings.displayRemaining') }
          ]}
          onChange={(display) => void setUsageSettings({ display })}
        />
      </SettingRow>
      {!isWindows && <MenuBarSettings />}
    </div>
  )
}

function MenuBarSettings(): React.JSX.Element | null {
  const { t } = useTranslation()
  const usage = useApp((s) => s.data?.settings.usage)
  const accounts = useApp((s) => s.data?.accounts) ?? []
  const setUsageSettings = useApp((s) => s.setUsageSettings)
  if (!usage) return null
  const trayOff = !usage.trayEnabled

  return (
    <>
      <Switch
        label={t('settings.trayEnabled')}
        hint={t('settings.trayEnabledHint')}
        checked={usage.trayEnabled}
        settingKey="usage.trayEnabled"
        onChange={(trayEnabled) => void setUsageSettings({ trayEnabled })}
      />
      <SettingRow settingKey="usage.trayMetric" label={t('settings.trayMetric')} disabled={trayOff}>
        <Segmented<TrayMetric>
          label={t('settings.trayMetric')}
          value={usage.trayMetric}
          disabled={trayOff}
          options={[
            { value: 'session', label: t('settings.metricSession') },
            { value: 'weekly', label: t('settings.metricWeekly') },
            { value: 'both', label: t('settings.metricBoth') }
          ]}
          onChange={(trayMetric) => void setUsageSettings({ trayMetric })}
        />
      </SettingRow>
      <SettingRow
        settingKey="usage.trayAccount"
        label={t('settings.trayAccount')}
        disabled={trayOff}
      >
        <select
          aria-label={t('settings.trayAccount')}
          className={`${inputClass} max-w-52 disabled:opacity-50`}
          disabled={trayOff}
          value={usage.trayAccount}
          onChange={(event) => void setUsageSettings({ trayAccount: event.target.value })}
        >
          <option value={TRAY_AUTO}>{t('settings.trayAccountAuto')}</option>
          <option value={TRAY_SELECTED}>{t('settings.trayAccountSelected')}</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </SettingRow>
    </>
  )
}
