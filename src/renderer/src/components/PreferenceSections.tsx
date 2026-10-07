import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TrayMetric, UsageDisplay } from '@shared/types'
import { useApp } from '../store'
import { Segmented } from '../ui/Segmented'
import { inputClass, sectionTitleClass } from '../ui/styles'
import { Switch } from '../ui/Switch'

const TRAY_AUTO = 'auto'
const TRAY_SELECTED = 'selected'

function Row({
  label,
  children,
  disabled
}: {
  label: string
  children: ReactNode
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className={`flex items-center justify-between gap-4 ${disabled ? 'text-muted' : ''}`}>
      <span className="min-w-0">{label}</span>
      {children}
    </div>
  )
}

/** Settings > Usage: display mode and the macOS menu bar item. */
export function UsageSettingsSection(): React.JSX.Element | null {
  const { t } = useTranslation()
  const usage = useApp((s) => s.data?.settings.usage)
  const accounts = useApp((s) => s.data?.accounts) ?? []
  const setUsageSettings = useApp((s) => s.setUsageSettings)
  if (!usage) return null
  const trayOff = !usage.trayEnabled

  return (
    <section className="mt-6 space-y-3">
      <h3 className={sectionTitleClass}>{t('settings.usage')}</h3>
      <Row label={t('settings.usageDisplay')}>
        <Segmented<UsageDisplay>
          label={t('settings.usageDisplay')}
          value={usage.display}
          options={[
            { value: 'used', label: t('settings.displayUsed') },
            { value: 'remaining', label: t('settings.displayRemaining') }
          ]}
          onChange={(display) => void setUsageSettings({ display })}
        />
      </Row>
      <Switch
        label={t('settings.trayEnabled')}
        hint={t('settings.trayEnabledHint')}
        checked={usage.trayEnabled}
        onChange={(trayEnabled) => void setUsageSettings({ trayEnabled })}
      />
      <Row label={t('settings.trayMetric')} disabled={trayOff}>
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
      </Row>
      <Row label={t('settings.trayAccount')} disabled={trayOff}>
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
      </Row>
    </section>
  )
}

/** Settings > General: login item. */
export function GeneralSettingsSection(): React.JSX.Element | null {
  const { t } = useTranslation()
  const launchAtLogin = useApp((s) => s.data?.settings.launchAtLogin)
  const setLaunchAtLogin = useApp((s) => s.setLaunchAtLogin)
  const [packaged, setPackaged] = useState(true)

  useEffect(() => {
    let alive = true
    window.api.app
      .packaged()
      .then((value) => alive && setPackaged(value))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  if (launchAtLogin === undefined) return null
  const hint = packaged
    ? t('settings.launchAtLoginHint')
    : `${t('settings.launchAtLoginHint')} ${t('settings.launchAtLoginDev')}`

  return (
    <section className="mt-6 space-y-2">
      <h3 className={sectionTitleClass}>{t('settings.general')}</h3>
      <Switch
        label={t('settings.launchAtLogin')}
        hint={hint}
        checked={launchAtLogin}
        onChange={(enabled) => void setLaunchAtLogin(enabled)}
      />
    </section>
  )
}
