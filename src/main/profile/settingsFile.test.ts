import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expectMode } from '../../test/platform'
import { readSettings, settingsPath, writeIfChanged, writeSettings } from './settingsFile'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'claudedeck-settings-'))

describe('settingsFile', () => {
  it('reads missing or empty files as {} and non-objects as null', () => {
    const dir = tempDir()
    const file = settingsPath(dir)
    expect(readSettings(file)).toEqual({})
    writeFileSync(file, '  \n')
    expect(readSettings(file)).toEqual({})
    writeFileSync(file, '[1]')
    expect(readSettings(file)).toBeNull()
    writeFileSync(file, '{ broken')
    expect(readSettings(file)).toBeNull()
    writeFileSync(file, '{"a":1}')
    expect(readSettings(file)).toEqual({ a: 1 })
  })

  it('writes settings pretty printed and private', () => {
    const file = settingsPath(tempDir())
    writeSettings(file, { a: { b: 1 } })
    expect(readFileSync(file, 'utf8')).toBe('{\n  "a": {\n    "b": 1\n  }\n}')
    expectMode(file, 0o600)
  })

  it('only writes when the content changed', () => {
    const file = join(tempDir(), 'x.sh')
    expect(writeIfChanged(file, 'one', 0o755)).toBe(true)
    expect(writeIfChanged(file, 'one', 0o755)).toBe(false)
    expect(writeIfChanged(file, 'two', 0o755)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('two')
  })
})
