import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ensureGuidelines,
  ensureGuidelinesImport,
  guidelinesPath,
  parseGuidelinesVersion
} from './guidelines'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'claudedeck-guidelines-'))
const bundled = (v: number): string => `<!-- claudedeck-guidelines v${v} -->\n# Guidelines v${v}\n`

describe('parseGuidelinesVersion', () => {
  it('reads the version from the first line', () => {
    expect(parseGuidelinesVersion('<!-- claudedeck-guidelines v3 -->\nbody')).toBe(3)
    expect(parseGuidelinesVersion('\uFEFF<!--claudedeck-guidelines   v12-->')).toBe(12)
  })
  it('returns null without a version line on the first line', () => {
    expect(parseGuidelinesVersion('# Title\n<!-- claudedeck-guidelines v3 -->')).toBeNull()
    expect(parseGuidelinesVersion('')).toBeNull()
  })
})

describe('ensureGuidelinesImport', () => {
  it('creates CLAUDE.md with the import line when missing', () => {
    const dir = tempDir()
    expect(ensureGuidelinesImport(dir)).toBe(true)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('@claudedeck/guidelines.md\n')
  })
  it('appends after a blank line and keeps user content', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'CLAUDE.md'), '# Mine\nKeep me')
    ensureGuidelinesImport(dir)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe(
      '# Mine\nKeep me\n\n@claudedeck/guidelines.md\n'
    )
  })
  it('leaves the file alone when the line is present', () => {
    const dir = tempDir()
    const content = '# Mine\n  @claudedeck/guidelines.md  \nmore'
    writeFileSync(join(dir, 'CLAUDE.md'), content)
    expect(ensureGuidelinesImport(dir)).toBe(false)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe(content)
  })
})

describe('ensureGuidelines', () => {
  it('installs when missing and reports from null', () => {
    const dir = tempDir()
    expect(ensureGuidelines(dir, bundled(2))).toEqual({ from: null, to: 2 })
    expect(readFileSync(guidelinesPath(dir), 'utf8')).toBe(bundled(2))
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('@claudedeck/guidelines.md')
  })
  it('upgrades an older version', () => {
    const dir = tempDir()
    ensureGuidelines(dir, bundled(1))
    expect(ensureGuidelines(dir, bundled(3))).toEqual({ from: 1, to: 3 })
    expect(readFileSync(guidelinesPath(dir), 'utf8')).toBe(bundled(3))
  })
  it('keeps the same or a newer installed version', () => {
    const dir = tempDir()
    ensureGuidelines(dir, bundled(4))
    expect(ensureGuidelines(dir, bundled(4))).toBeNull()
    expect(ensureGuidelines(dir, bundled(2))).toBeNull()
    expect(readFileSync(guidelinesPath(dir), 'utf8')).toBe(bundled(4))
  })
  it('restores the import line even when the file is current', () => {
    const dir = tempDir()
    ensureGuidelines(dir, bundled(1))
    writeFileSync(join(dir, 'CLAUDE.md'), '# Replaced by the user\n')
    expect(ensureGuidelines(dir, bundled(1))).toBeNull()
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe(
      '# Replaced by the user\n\n@claudedeck/guidelines.md\n'
    )
  })
  it('rejects bundled text without a version and leaves no temp files', () => {
    const dir = tempDir()
    expect(() => ensureGuidelines(dir, '# no version')).toThrow()
    mkdirSync(join(dir, 'claudedeck'), { recursive: true })
    ensureGuidelines(dir, bundled(1))
    expect(readdirSync(join(dir, 'claudedeck')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
