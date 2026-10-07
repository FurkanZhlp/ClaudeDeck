/**
 * Locale files keep platform specific wording under `platformCopy.<platform>`, mirroring the
 * normal key tree (e.g. `platformCopy.win32.notes.reveal` replaces `notes.reveal` on Windows).
 */
export const PLATFORM_COPY_KEY = 'platformCopy'

type Dictionary = { [key: string]: unknown }

const isDictionary = (value: unknown): value is Dictionary =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function merge(base: Dictionary, overrides: Dictionary): Dictionary {
  const result: Dictionary = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    const current = result[key]
    result[key] = isDictionary(current) && isDictionary(value) ? merge(current, value) : value
  }
  return result
}

/** The dictionary with the platform's wording applied and the variants section removed. */
export function withPlatformCopy(dictionary: object, platform: string): Dictionary {
  const { [PLATFORM_COPY_KEY]: variants, ...base } = dictionary as Dictionary
  const overrides = isDictionary(variants) ? variants[platform] : undefined
  return isDictionary(overrides) ? merge(base, overrides) : base
}
