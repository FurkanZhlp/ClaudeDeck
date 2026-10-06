import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const GUIDELINES_IMPORT_LINE = '@claudedeck/guidelines.md'
const VERSION_LINE = /^<!--\s*claudedeck-guidelines\s+v(\d+)\s*-->/

export const guidelinesPath = (configDir: string): string =>
  join(configDir, 'claudedeck', 'guidelines.md')

/** Writes through a temp file so readers never see a half-written file. */
export function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.claudedeck-tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/** Reads the version from a first line like `<!-- claudedeck-guidelines v3 -->`. */
export function parseGuidelinesVersion(text: string): number | null {
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? ''
  const match = VERSION_LINE.exec(first.trim())
  return match ? Number(match[1]) : null
}

/**
 * Makes sure `<configDir>/CLAUDE.md` imports the guidelines. Only ever appends the import line;
 * user content is left untouched. Returns true when the file was changed.
 */
export function ensureGuidelinesImport(configDir: string): boolean {
  const file = join(configDir, 'CLAUDE.md')
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (current.split(/\r?\n/).some((line) => line.trim() === GUIDELINES_IMPORT_LINE)) return false
  let next = `${GUIDELINES_IMPORT_LINE}\n`
  if (current.trim() !== '') {
    next = `${current}${current.endsWith('\n') ? '' : '\n'}\n${next}`
  }
  writeFileAtomic(file, next)
  return true
}

/**
 * Installs the bundled guidelines when they are missing or older than the bundled version.
 * Returns the old and new version when the file was written, otherwise null.
 */
export function ensureGuidelines(
  configDir: string,
  bundledText: string
): { from: number | null; to: number } | null {
  const to = parseGuidelinesVersion(bundledText)
  if (to === null) throw new Error('bundled guidelines have no version line')
  const file = guidelinesPath(configDir)
  const from = existsSync(file) ? parseGuidelinesVersion(readFileSync(file, 'utf8')) : null
  let result: { from: number | null; to: number } | null = null
  if (from === null || from < to) {
    writeFileAtomic(file, bundledText)
    result = { from, to }
  }
  ensureGuidelinesImport(configDir)
  return result
}
