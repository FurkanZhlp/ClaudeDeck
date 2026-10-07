import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expectMode } from '../../test/platform'
import {
  readSettings,
  settingsPath,
  updateSettings,
  writeIfChanged,
  writeSettings
} from './settingsFile'

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

  it('writes through a symlinked settings.json to its target and keeps the link', () => {
    const dir = tempDir()
    const target = join(dir, 'dotfiles-settings.json')
    writeFileSync(target, '{"a":1}')
    const file = settingsPath(dir)
    try {
      symlinkSync(target, file)
    } catch {
      return // links refused (Windows without rights)
    }
    writeSettings(file, { a: 2 })
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ a: 2 })
  })

  it('does not replace a file that changed after it was read', () => {
    const file = settingsPath(tempDir())
    writeFileSync(file, '{"a":1}')
    expect(writeSettings(file, { a: 2 }, { unchangedFrom: '{"a":0}' })).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}')
    expect(writeSettings(file, { a: 2 }, { unchangedFrom: '{"a":1}' })).toBe(true)
    expect(readSettings(file)).toEqual({ a: 2 })
  })

  it('starts an update over when the file changes meanwhile, keeping the other write', () => {
    const file = settingsPath(tempDir())
    writeFileSync(file, '{"a":1}')
    let calls = 0
    const result = updateSettings(file, (settings) => {
      calls += 1
      // Claude Code writes the file between our read and our rename (first attempt only).
      if (calls === 1) writeFileSync(file, '{"a":1,"model":"opus"}')
      return { ...settings, hooks: {} }
    })
    expect(result).toBe('written')
    expect(calls).toBe(2)
    expect(readSettings(file)).toEqual({ a: 1, model: 'opus', hooks: {} })
  })

  it('gives up after repeated concurrent changes and never touches invalid files', () => {
    const file = settingsPath(tempDir())
    writeFileSync(file, '{}')
    let n = 0
    expect(() =>
      updateSettings(file, () => {
        writeFileSync(file, `{"n":${++n}}`)
        return { mine: true }
      })
    ).toThrow(/kept changing/)
    expect(readSettings(file)).toEqual({ n: 3 })
    writeFileSync(file, '{ broken')
    expect(updateSettings(file, () => ({ x: 1 }))).toBe('invalid')
    expect(readFileSync(file, 'utf8')).toBe('{ broken')
  })
})
