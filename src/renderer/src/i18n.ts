import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shared/locales/en.json'
import tr from '@shared/locales/tr.json'
import { withPlatformCopy } from '@shared/platformCopy'
import { platform } from './platform'

void i18n.use(initReactI18next).init({
  // Platform specific wording (e.g. File Explorer instead of Finder) replaces the default strings.
  resources: {
    tr: { translation: withPlatformCopy(tr, platform) },
    en: { translation: withPlatformCopy(en, platform) }
  },
  lng: 'tr',
  fallbackLng: 'en',
  interpolation: { escapeValue: false }
})

export default i18n
