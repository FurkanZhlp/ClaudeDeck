import type { Language } from './types'

export const LANGUAGES: readonly Language[] = ['tr', 'en']

export function resolveLanguage(preference: Language | null, locale: string): Language {
  if (preference) return preference
  return locale.toLowerCase().startsWith('tr') ? 'tr' : 'en'
}
