/**
 * Settings section ids and the remembered last section. Kept free of components so the store
 * can use it without importing the section registry.
 */
export const SETTINGS_SECTION_IDS = [
  'accounts',
  'claude',
  'guard',
  'testQueue',
  'usage',
  'general',
  'about'
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'accounts'

const STORAGE_KEY = 'claudedeck.settings.section'

export const isSettingsSectionId = (value: unknown): value is SettingsSectionId =>
  typeof value === 'string' && (SETTINGS_SECTION_IDS as readonly string[]).includes(value)

/** Storage can be missing or throw (private mode, blocked site data); both fall back. */
export function readLastSection(
  storage: Storage | undefined = globalThis.localStorage
): SettingsSectionId {
  try {
    const value = storage?.getItem(STORAGE_KEY)
    return isSettingsSectionId(value) ? value : DEFAULT_SETTINGS_SECTION
  } catch {
    return DEFAULT_SETTINGS_SECTION
  }
}

export function writeLastSection(
  section: SettingsSectionId,
  storage: Storage | undefined = globalThis.localStorage
): void {
  try {
    storage?.setItem(STORAGE_KEY, section)
  } catch {
    // Remembering the section is a convenience; losing it is fine.
  }
}
