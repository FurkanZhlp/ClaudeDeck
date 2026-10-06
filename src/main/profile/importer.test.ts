import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProfileCategory } from '../../shared/types'
import {
  copyEntry,
  diffProfile,
  importProfile,
  mergeSettings,
  rewritePaths,
  summarizeSource
} from './importer'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'claudedeck-import-'))

function put(root: string, rel: string, content: string): void {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8')
const readJson = (root: string, rel: string): Record<string, unknown> =>
  JSON.parse(read(root, rel)) as Record<string, unknown>

/** Every entry under `root` with its type, content hash and mtime. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name)
      const key = rel ? `${rel}/${name}` : name
      const stats = lstatSync(abs)
      if (stats.isDirectory()) {
        out[key] = `dir:${stats.mtimeMs}`
        walk(abs, key)
      } else {
        const hash = createHash('sha256').update(readFileSync(abs)).digest('hex')
        out[key] = `file:${hash}:${stats.mtimeMs}:${stats.mode}`
      }
    }
  }
  walk(root, '')
  return out
}

function makeSource(): string {
  const src = tempDir()
  put(src, 'CLAUDE.md', '# Global rules\n')
  put(src, 'agents/a.md', 'agent a')
  put(src, 'agents/b.md', 'agent b')
  put(src, 'agents/.DS_Store', 'x')
  put(src, 'skills/one/SKILL.md', 'skill one')
  put(src, 'commands/c.md', 'command')
  put(
    src,
    'settings.json',
    JSON.stringify({
      model: 'opus',
      apiKeyHelper: '/bin/secret',
      env: { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', FOO: 'bar' },
      permissions: { allow: ['Bash(ls)'] }
    })
  )
  put(
    src,
    'plugins/installed_plugins.json',
    JSON.stringify({
      plugins: { x: [{ installPath: join(src, 'plugins/cache/x'), other: '/elsewhere/x' }] }
    })
  )
  put(
    src,
    'plugins/known_marketplaces.json',
    JSON.stringify({ m: { installLocation: join(src, 'plugins/marketplaces/m') } })
  )
  put(src, 'plugins/cache/x/plugin.json', '{}')
  put(src, '.claude.json', '{"oauthAccount":{}}')
  put(src, '.credentials.json', 'secret')
  put(src, 'projects/p/memory/MEMORY.md', 'memory')
  put(src, 'history.jsonl', '{}')
  return src
}

const ALL: ProfileCategory[] = [
  'instructions',
  'agents',
  'skills',
  'commands',
  'outputStyles',
  'settings',
  'plugins'
]

describe('summarizeSource', () => {
  it('counts top-level entries per category', () => {
    const summary = summarizeSource(makeSource())
    const by = Object.fromEntries(summary.map((s) => [s.category, s]))
    expect(by.instructions).toEqual({ category: 'instructions', available: true, items: 1 })
    expect(by.agents.items).toBe(2)
    expect(by.skills.items).toBe(1)
    expect(by.outputStyles).toEqual({ category: 'outputStyles', available: false, items: 0 })
    expect(by.settings.items).toBe(1)
    expect(by.plugins.items).toBe(3)
  })
  it('reports nothing for a missing source', () => {
    const summary = summarizeSource(join(tempDir(), 'missing'))
    expect(summary).toHaveLength(7)
    expect(summary.every((s) => !s.available && s.items === 0)).toBe(true)
  })
})

describe('diffProfile', () => {
  it('counts added, changed and removed files per category', () => {
    const src = makeSource()
    const dst = tempDir()
    put(dst, 'agents/a.md', 'agent a')
    put(dst, 'agents/b.md', 'agent B')
    put(dst, 'agents/old.md', 'old')
    const by = Object.fromEntries(diffProfile(src, dst).map((d) => [d.category, d]))
    expect(by.agents).toEqual({ category: 'agents', added: 0, changed: 1, removed: 1 })
    expect(by.skills).toMatchObject({ added: 1, changed: 0, removed: 0 })
    expect(by.plugins).toMatchObject({ added: 3 })
    expect(by.outputStyles).toMatchObject({ added: 0, changed: 0, removed: 0 })
  })
  it('treats same content with a different mtime as unchanged', () => {
    const src = tempDir()
    const dst = tempDir()
    put(src, 'commands/c.md', 'same')
    put(dst, 'commands/c.md', 'same')
    utimesSync(join(dst, 'commands/c.md'), new Date(1000), new Date(1000))
    const by = Object.fromEntries(diffProfile(src, dst).map((d) => [d.category, d]))
    expect(by.commands).toMatchObject({ added: 0, changed: 0, removed: 0 })
  })
})

describe('mergeSettings', () => {
  it('lets imported keys win, keeps account keys, strips secrets and unions allow rules', () => {
    const merged = mergeSettings(
      {
        theme: 'light',
        model: 'sonnet',
        apiKeyHelper: '/mine',
        permissions: { allow: ['Read', 'Bash(git:*)'], deny: ['X'] }
      },
      {
        model: 'opus',
        apiKeyHelper: '/theirs',
        env: { ANTHROPIC_AUTH_TOKEN: 'a', FOO: '1' },
        permissions: { allow: ['Read', 'Edit'] }
      }
    )
    expect(merged).toEqual({
      theme: 'light',
      model: 'opus',
      apiKeyHelper: '/mine',
      env: { FOO: '1' },
      permissions: { allow: ['Read', 'Edit', 'Bash(git:*)'] }
    })
  })
})

describe('rewritePaths', () => {
  it('rewrites only values under the source root', () => {
    expect(
      rewritePaths(
        { a: ['/src/x', '/srcother/y', '/src'], b: { c: '/src/z' }, n: 1 },
        '/src',
        '/dst'
      )
    ).toEqual({ a: ['/dst/x', '/srcother/y', '/src'], b: { c: '/dst/z' }, n: 1 })
  })
})

describe('copyEntry', () => {
  it('falls back to a regular copy when cloning fails', () => {
    const src = tempDir()
    const dst = tempDir()
    put(src, 'skills/s/SKILL.md', 'skill')
    copyEntry(join(src, 'skills'), join(dst, 'skills'), true, () => {
      throw new Error('clone failed')
    })
    expect(read(dst, 'skills/s/SKILL.md')).toBe('skill')
  })
  it('copies a symlinked folder as a real folder with real files', () => {
    const real = tempDir()
    const src = tempDir()
    const dst = tempDir()
    put(real, 'agents/a.md', 'linked agent')
    put(real, 'shared.md', 'shared')
    symlinkSync(join(real, 'shared.md'), join(real, 'agents/link.md'))
    symlinkSync(join(real, 'agents'), join(src, 'agents'))
    copyEntry(join(src, 'agents'), join(dst, 'agents'), true)
    expect(lstatSync(join(dst, 'agents')).isDirectory()).toBe(true)
    expect(lstatSync(join(dst, 'agents/link.md')).isSymbolicLink()).toBe(false)
    expect(read(dst, 'agents/link.md')).toBe('shared')
  })
})

describe('importProfile', () => {
  it('copies chosen categories and never the excluded files', () => {
    const src = makeSource()
    const dst = tempDir()
    const result = importProfile(src, dst, ['agents', 'skills', 'outputStyles'])
    expect(result).toEqual({ imported: ['agents', 'skills'], backupDir: null })
    expect(read(dst, 'agents/a.md')).toBe('agent a')
    expect(read(dst, 'skills/one/SKILL.md')).toBe('skill one')
    expect(existsSync(join(dst, 'commands'))).toBe(false)
    for (const name of ['.claude.json', '.credentials.json', 'projects', 'history.jsonl']) {
      expect(existsSync(join(dst, name))).toBe(false)
    }
  })

  it('moves existing items to a timestamped backup first', () => {
    const src = makeSource()
    const dst = tempDir()
    put(dst, 'agents/mine.md', 'mine')
    put(dst, 'commands/keep.md', 'untouched')
    const now = new Date('2026-10-07T10:20:30.000Z')
    const result = importProfile(src, dst, ['agents'], now)
    const backupDir = join(dst, 'claudedeck', 'backups', '2026-10-07T10-20-30.000Z')
    expect(result.backupDir).toBe(backupDir)
    expect(read(backupDir, 'agents/mine.md')).toBe('mine')
    expect(existsSync(join(dst, 'agents/mine.md'))).toBe(false)
    expect(read(dst, 'commands/keep.md')).toBe('untouched')
    expect(importProfile(src, dst, ['agents'], now).backupDir).toBe(`${backupDir}-1`)
  })

  it('merges settings instead of replacing them', () => {
    const src = makeSource()
    const dst = tempDir()
    put(
      dst,
      'settings.json',
      JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(npm test)'] } })
    )
    const result = importProfile(src, dst, ['settings'])
    expect(result.backupDir).not.toBeNull()
    expect(readJson(dst, 'settings.json')).toEqual({
      theme: 'dark',
      model: 'opus',
      env: { FOO: 'bar' },
      permissions: { allow: ['Bash(ls)', 'Bash(npm test)'] }
    })
  })

  it('rewrites plugin paths to the account dir', () => {
    const src = makeSource()
    const dst = tempDir()
    importProfile(src, dst, ['plugins'])
    const installed = readJson(dst, 'plugins/installed_plugins.json')
    expect(installed).toEqual({
      plugins: { x: [{ installPath: join(dst, 'plugins/cache/x'), other: '/elsewhere/x' }] }
    })
    expect(readJson(dst, 'plugins/known_marketplaces.json')).toEqual({
      m: { installLocation: join(dst, 'plugins/marketplaces/m') }
    })
    expect(read(dst, 'plugins/cache/x/plugin.json')).toBe('{}')
  })

  it('adds the guidelines import after copying CLAUDE.md', () => {
    const src = makeSource()
    const dst = tempDir()
    importProfile(src, dst, ['instructions'])
    expect(read(dst, 'CLAUDE.md')).toBe('# Global rules\n\n@claudedeck/guidelines.md\n')
  })

  it('leaves the source tree byte-identical', () => {
    const src = makeSource()
    const dst = tempDir()
    put(dst, 'agents/mine.md', 'mine')
    put(dst, 'settings.json', '{"theme":"dark"}')
    const before = snapshot(src)
    importProfile(src, dst, ALL)
    importProfile(src, dst, ALL)
    expect(snapshot(src)).toEqual(before)
  })

  it('refuses overlapping source and target', () => {
    const src = makeSource()
    expect(() => importProfile(src, src, ['agents'])).toThrow()
    expect(() => importProfile(src, join(src, 'nested'), ['agents'])).toThrow()
  })

  it('keeps the target settings when the source settings are invalid', () => {
    const src = tempDir()
    const dst = tempDir()
    put(src, 'settings.json', '{broken')
    put(dst, 'settings.json', '{"theme":"dark"}')
    expect(() => importProfile(src, dst, ['settings'])).toThrow()
    expect(read(dst, 'settings.json')).toBe('{"theme":"dark"}')
  })

  it('does not back up a CLAUDE.md that only holds the app import line', () => {
    const src = mkdtempSync(join(tmpdir(), 'cd-src-'))
    const dst = mkdtempSync(join(tmpdir(), 'cd-dst-'))
    writeFileSync(join(src, 'CLAUDE.md'), '# Mine\n')
    writeFileSync(join(dst, 'CLAUDE.md'), '@claudedeck/guidelines.md\n')
    const result = importProfile(src, dst, ['instructions'])
    expect(result.backupDir).toBeNull()
    expect(readFileSync(join(dst, 'CLAUDE.md'), 'utf8')).toContain('# Mine')
    expect(readFileSync(join(dst, 'CLAUDE.md'), 'utf8')).toContain('@claudedeck/guidelines.md')
  })
})
