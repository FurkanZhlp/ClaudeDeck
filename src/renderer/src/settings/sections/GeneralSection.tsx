import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Language } from '@shared/types'
import { useApp } from '../../store'
import { inputClass } from '../../ui/styles'
import { Switch } from '../../ui/Switch'
import { SettingRow } from '../SettingRow'

/** Settings > General: interface language and the login item. */
export function GeneralSection(): React.JSX.Element | null {
  const { t } = useTranslation()
  const language = useApp((s) => s.data?.settings.language)
  const setLanguage = useApp((s) => s.setLanguage)
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

  const hint = packaged
    ? t('settings.launchAtLoginHint')
    : `${t('settings.launchAtLoginHint')} ${t('settings.launchAtLoginDev')}`

  return (
    <div className="space-y-3">
      <SettingRow settingKey="general.language" label={t('settings.language')}>
        <select
          aria-label={t('settings.language')}
          className={`${inputClass} max-w-52`}
          value={language ?? 'system'}
          onChange={(event) =>
            void setLanguage(
              event.target.value === 'system' ? null : (event.target.value as Language)
            )
          }
        >
          <option value="system">{t('settings.languageSystem')}</option>
          <option value="tr">Türkçe</option>
          <option value="en">English</option>
        </select>
      </SettingRow>
      {launchAtLogin !== undefined && (
        <Switch
          label={t('settings.launchAtLogin')}
          hint={hint}
          checked={launchAtLogin}
          settingKey="general.launchAtLogin"
          onChange={(enabled) => void setLaunchAtLogin(enabled)}
        />
      )}
    </div>
  )
}
