import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button'
import { SettingRow } from '../SettingRow'

/** Settings > About: version and a manual update check (the app menu is macOS only). */
export function AboutSection(): React.JSX.Element {
  const { t } = useTranslation()
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.api.app
      .version()
      .then((value) => alive && setVersion(value))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  return (
    <SettingRow label={version ? t('settings.version', { version }) : 'ClaudeDeck'}>
      <Button onClick={() => void window.api.app.checkUpdates()}>
        <RefreshCw size={14} />
        {t('settings.checkUpdates')}
      </Button>
    </SettingRow>
  )
}
