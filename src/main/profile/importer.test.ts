import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  chmodSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProfileCategory } from '../../shared/types'
import { nodeCopy } from '../platform/fs'
import {
  ProfileImportError,
  copyEntry,
  diffProfile,
  importProfile,
  importRefAllowed,
  mergeSettings,
  rewritePaths,
  summarizeSource
} from './importer'

const failingClone = async (): Promise<void> => {
  throw new Error('clone failed')
}

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
  it('counts top-level entries per category', async () => {
    const summary = summarizeSource(makeSource())
    const by = Object.fromEntries(summary.map((s) => [s.category, s]))
    expect(by.instructions).toEqual({ category: 'instructions', available: true, items: 1 })
    expect(by.agents.items).toBe(2)
    expect(by.skills.items).toBe(1)
    expect(by.outputStyles).toEqual({ category: 'outputStyles', available: false, items: 0 })
    expect(by.settings.items).toBe(1)
    expect(by.plugins.items).toBe(3)
  })
  it('ignores Finder and Explorer metadata files', async () => {
    const src = makeSource()
    for (const junk of ['.DS_Store', 'Thumbs.db', 'desktop.ini']) {
      writeFileSync(join(src, 'agents', junk), 'x')
    }
    const by = Object.fromEntries(summarizeSource(src).map((s) => [s.category, s]))
    expect(by.agents.items).toBe(2)
    const dst = tempDir()
    await importProfile(src, dst, ['agents'])
    expect((await diffProfile(src, dst)).find((d) => d.category === 'agents')).toMatchObject({
      added: 0,
      changed: 0,
      removed: 0
    })
  })

  it('reports nothing for a missing source', async () => {
    const summary = summarizeSource(join(tempDir(), 'missing'))
    expect(summary).toHaveLength(7)
    expect(summary.every((s) => !s.available && s.items === 0)).toBe(true)
  })
})

describe('diffProfile', () => {
  it('counts added, changed and removed files per category', async () => {
    const src = makeSource()
    const dst = tempDir()
    put(dst, 'agents/a.md', 'agent a')
    put(dst, 'agents/b.md', 'agent B')
    put(dst, 'agents/old.md', 'old')
    const by = Object.fromEntries((await diffProfile(src, dst)).map((d) => [d.category, d]))
    expect(by.agents).toEqual({ category: 'agents', added: 0, changed: 1, removed: 1 })
    expect(by.skills).toMatchObject({ added: 1, changed: 0, removed: 0 })
    expect(by.plugins).toMatchObject({ added: 3 })
    expect(by.outputStyles).toMatchObject({ added: 0, changed: 0, removed: 0 })
  })
  it('treats same content with a different mtime as unchanged', async () => {
    const src = tempDir()
    const dst = tempDir()
    put(src, 'commands/c.md', 'same')
    put(dst, 'commands/c.md', 'same')
    utimesSync(join(dst, 'commands/c.md'), new Date(1000), new Date(1000))
    const by = Object.fromEntries((await diffProfile(src, dst)).map((d) => [d.category, d]))
    expect(by.commands).toMatchObject({ added: 0, changed: 0, removed: 0 })
  })
})

describe('mergeSettings', () => {
  it('lets imported keys win, keeps account keys, strips secrets and unions allow rules', async () => {
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
      permissions: { allow: ['Read', 'Edit', 'Bash(git:*)'], deny: ['X'] }
    })
  })

  it('keeps the account safety rules and its default mode', () => {
    const merged = mergeSettings(
      {
        env: { MINE: '1', MY_TOKEN: 'keep' },
        permissions: {
          deny: ['Bash(rm:*)'],
          ask: ['Bash(git push:*)'],
          additionalDirectories: ['/a'],
          defaultMode: 'default'
        }
      },
      {
        awsAuthRefresh: 'x',
        awsCredentialExport: 'x',
        otelHeadersHelper: 'x',
        env: { GITHUB_TOKEN: 's', DB_PASSWORD: 's', aws_secret: 's', Api_Key: 's', OK: '2' },
        permissions: {
          deny: ['Read(.env)'],
          ask: ['Bash(git push:*)'],
          additionalDirectories: ['/b'],
          defaultMode: 'bypassPermissions'
        }
      }
    )
    expect(merged).toEqual({
      env: { MINE: '1', MY_TOKEN: 'keep', OK: '2' },
      permissions: {
        deny: ['Read(.env)', 'Bash(rm:*)'],
        ask: ['Bash(git push:*)'],
        additionalDirectories: ['/b', '/a'],
        defaultMode: 'default'
      }
    })
  })

  it('takes the source default mode only when the account has none', () => {
    const merged = mergeSettings(
      { permissions: { allow: ['Read'] } },
      { permissions: { defaultMode: 'acceptEdits' } }
    )
    expect(merged.permissions).toEqual({ allow: ['Read'], defaultMode: 'acceptEdits' })
  })
})

describe('rewritePaths', () => {
  it('rewrites only values under the source root', async () => {
    expect(
      rewritePaths(
        { a: ['/src/x', '/srcother/y', '/src'], b: { c: '/src/z' }, n: 1 },
        '/src',
        '/dst'
      )
    ).toEqual({ a: ['/dst/x', '/srcother/y', '/src'], b: { c: '/dst/z' }, n: 1 })
  })

  it('matches Windows paths case-insensitively with either separator', () => {
    const from = 'C:\\Users\\Me\\.claude'
    const to = 'C:\\Users\\Me\\AppData\\Roaming\\ClaudeDeck\\accounts\\a1'
    expect(
      rewritePaths(
        [
          'c:\\users\\me\\.claude\\plugins\\x',
          'C:/Users/Me/.claude/plugins/y',
          'C:\\Users\\Me\\.claude-other\\z',
          'C:\\Users\\Me\\.claude'
        ],
        from,
        to,
        win32
      )
    ).toEqual([
      `${to}\\plugins\\x`,
      `${to}\\plugins/y`,
      'C:\\Users\\Me\\.claude-other\\z',
      'C:\\Users\\Me\\.claude'
    ])
  })

  it('stays case-sensitive with POSIX paths', () => {
    expect(rewritePaths(['/SRC/x', '/src/x'], '/src', '/dst', posix)).toEqual(['/SRC/x', '/dst/x'])
  })
})

describe('copyEntry', () => {
  it('does not repeat a failed plain copy', async () => {
    const src = tempDir()
    let calls = 0
    const plain = async (): Promise<void> => {
      calls++
      throw new Error('copy failed')
    }
    // A failing runner (the APFS clone) falls back to the plain copy once.
    await expect(copyEntry(src, join(tempDir(), 'x'), false, plain)).resolves.toBeUndefined()
    expect(calls).toBe(1)
    // The plain copy (Windows) is not run a second time: its failure stands as it is.
    const blocked = join(tempDir(), 'file')
    writeFileSync(blocked, 'keep')
    await expect(copyEntry(src, blocked, false, nodeCopy)).rejects.toThrow()
    expect(readFileSync(blocked, 'utf8')).toBe('keep')
  })

  it('falls back to a regular copy when cloning fails', async () => {
    const src = tempDir()
    const dst = tempDir()
    put(src, 'skills/s/SKILL.md', 'skill')
    await copyEntry(join(src, 'skills'), join(dst, 'skills'), true, failingClone)
    expect(read(dst, 'skills/s/SKILL.md')).toBe('skill')
  })
  it('copies a symlinked folder as a real folder with real files', async () => {
    const real = tempDir()
    const src = tempDir()
    const dst = tempDir()
    put(real, 'agents/a.md', 'linked agent')
    put(real, 'shared.md', 'shared')
    symlinkSync(join(real, 'shared.md'), join(real, 'agents/link.md'))
    symlinkSync(join(real, 'agents'), join(src, 'agents'))
    await copyEntry(join(src, 'agents'), join(dst, 'agents'), true)
    expect(lstatSync(join(dst, 'agents')).isDirectory()).toBe(true)
    expect(lstatSync(join(dst, 'agents/link.md')).isSymbolicLink()).toBe(false)
    expect(read(dst, 'agents/link.md')).toBe('shared')
  })
})

describe('importProfile', () => {
  it('copies chosen categories and never the excluded files', async () => {
    const src = makeSource()
    const dst = tempDir()
    const result = await importProfile(src, dst, ['agents', 'skills', 'outputStyles'])
    expect(result).toEqual({ imported: ['agents', 'skills'], backupDir: null })
    expect(read(dst, 'agents/a.md')).toBe('agent a')
    expect(read(dst, 'skills/one/SKILL.md')).toBe('skill one')
    expect(existsSync(join(dst, 'commands'))).toBe(false)
    for (const name of ['.claude.json', '.credentials.json', 'projects', 'history.jsonl']) {
      expect(existsSync(join(dst, name))).toBe(false)
    }
  })

  it('moves existing items to a timestamped backup first', async () => {
    const src = makeSource()
    const dst = tempDir()
    put(dst, 'agents/mine.md', 'mine')
    put(dst, 'commands/keep.md', 'untouched')
    const now = new Date('2026-10-07T10:20:30.000Z')
    const result = await importProfile(src, dst, ['agents'], now)
    const backupDir = join(dst, 'claudedeck', 'backups', '2026-10-07T10-20-30.000Z')
    expect(result.backupDir).toBe(backupDir)
    expect(read(backupDir, 'agents/mine.md')).toBe('mine')
    expect(existsSync(join(dst, 'agents/mine.md'))).toBe(false)
    expect(read(dst, 'commands/keep.md')).toBe('untouched')
    expect((await importProfile(src, dst, ['agents'], now)).backupDir).toBe(`${backupDir}-1`)
  })

  it('merges settings instead of replacing them', async () => {
    const src = makeSource()
    const dst = tempDir()
    put(
      dst,
      'settings.json',
      JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(npm test)'] } })
    )
    const result = await importProfile(src, dst, ['settings'])
    expect(result.backupDir).not.toBeNull()
    expect(readJson(dst, 'settings.json')).toEqual({
      theme: 'dark',
      model: 'opus',
      env: { FOO: 'bar' },
      permissions: { allow: ['Bash(ls)', 'Bash(npm test)'] }
    })
  })

  it('writes settings.json readable by the owner only', async () => {
    const src = makeSource()
    const dst = tempDir()
    await importProfile(src, dst, ['settings'])
    expect(statSync(join(dst, 'settings.json')).mode & 0o777).toBe(0o600)
  })

  it('rewrites plugin paths to the account dir', async () => {
    const src = makeSource()
    const dst = tempDir()
    await importProfile(src, dst, ['plugins'])
    const installed = readJson(dst, 'plugins/installed_plugins.json')
    expect(installed).toEqual({
      plugins: { x: [{ installPath: join(dst, 'plugins/cache/x'), other: '/elsewhere/x' }] }
    })
    expect(readJson(dst, 'plugins/known_marketplaces.json')).toEqual({
      m: { installLocation: join(dst, 'plugins/marketplaces/m') }
    })
    expect(read(dst, 'plugins/cache/x/plugin.json')).toBe('{}')
  })

  it('adds the guidelines import after copying CLAUDE.md', async () => {
    const src = makeSource()
    const dst = tempDir()
    await importProfile(src, dst, ['instructions'])
    expect(read(dst, 'CLAUDE.md')).toBe('# Global rules\n\n@claudedeck/guidelines.md\n')
  })

  it('leaves the source tree byte-identical', async () => {
    const src = makeSource()
    const dst = tempDir()
    put(dst, 'agents/mine.md', 'mine')
    put(dst, 'settings.json', '{"theme":"dark"}')
    const before = snapshot(src)
    await importProfile(src, dst, ALL)
    await importProfile(src, dst, ALL)
    expect(snapshot(src)).toEqual(before)
  })

  it('refuses overlapping source and target', async () => {
    const src = makeSource()
    await expect(importProfile(src, src, ['agents'])).rejects.toThrow()
    await expect(importProfile(src, join(src, 'nested'), ['agents'])).rejects.toThrow()
  })

  it('keeps the target settings when the source settings are invalid', async () => {
    const src = tempDir()
    const dst = tempDir()
    put(src, 'settings.json', '{broken')
    put(dst, 'settings.json', '{"theme":"dark"}')
    await expect(importProfile(src, dst, ['settings'])).rejects.toThrow(/settings/)
    expect(read(dst, 'settings.json')).toBe('{"theme":"dark"}')
  })

  it('does not back up a CLAUDE.md that only holds the app import line', async () => {
    const src = mkdtempSync(join(tmpdir(), 'cd-src-'))
    const dst = mkdtempSync(join(tmpdir(), 'cd-dst-'))
    writeFileSync(join(src, 'CLAUDE.md'), '# Mine\n')
    writeFileSync(join(dst, 'CLAUDE.md'), '@claudedeck/guidelines.md\n')
    const result = await importProfile(src, dst, ['instructions'])
    expect(result.backupDir).toBeNull()
    expect(readFileSync(join(dst, 'CLAUDE.md'), 'utf8')).toContain('# Mine')
    expect(readFileSync(join(dst, 'CLAUDE.md'), 'utf8')).toContain('@claudedeck/guidelines.md')
  })
})

describe('symlinks', () => {
  /** Plugins with a relative link inside the entry and an absolute link into the source root. */
  function pluginSource(): string {
    const src = tempDir()
    put(src, 'plugins/b/file.md', 'target file')
    put(src, 'CLAUDE.md', '# root')
    mkdirSync(join(src, 'plugins/a'), { recursive: true })
    symlinkSync('../b/file.md', join(src, 'plugins/a/rel.md'))
    symlinkSync(join(src, 'plugins/b/file.md'), join(src, 'plugins/a/abs.md'))
    symlinkSync(join(src, 'CLAUDE.md'), join(src, 'plugins/a/root.md'))
    return src
  }

  for (const [name, run] of [
    ['clone', undefined],
    ['fallback copy', failingClone]
  ] as const) {
    it(`keeps plugin links inside the target profile (${name})`, async () => {
      const src = pluginSource()
      const dst = tempDir()
      await importProfile(src, dst, ['plugins'], new Date(), run)
      expect(readlinkSync(join(dst, 'plugins/a/rel.md'))).toBe('../b/file.md')
      expect(readlinkSync(join(dst, 'plugins/a/abs.md'))).toBe(join(dst, 'plugins/b/file.md'))
      expect(readlinkSync(join(dst, 'plugins/a/root.md'))).toBe(join(dst, 'CLAUDE.md'))
      expect(read(dst, 'plugins/a/rel.md')).toBe('target file')
      const by = Object.fromEntries((await diffProfile(src, dst)).map((d) => [d.category, d]))
      expect(by.plugins).toMatchObject({ added: 0, changed: 0, removed: 0 })
    })
  }

  it('shows no changes after importing symlinked skills', async () => {
    const real = tempDir()
    const src = tempDir()
    const dst = tempDir()
    put(real, 'foo/SKILL.md', 'linked skill')
    put(real, 'foo/ref.md', 'reference')
    put(src, 'skills/plain/SKILL.md', 'plain')
    symlinkSync(join(real, 'foo'), join(src, 'skills/foo'))
    symlinkSync(join(real, 'foo/ref.md'), join(src, 'skills/plain/ref.md'))
    await importProfile(src, dst, ['skills'])
    expect(lstatSync(join(dst, 'skills/foo')).isDirectory()).toBe(true)
    const by = Object.fromEntries((await diffProfile(src, dst)).map((d) => [d.category, d]))
    expect(by.skills).toEqual({ category: 'skills', added: 0, changed: 0, removed: 0 })
  })
})

describe('import atomicity', () => {
  it('keeps the previous item when copying a category fails', async () => {
    const src = tempDir()
    const dst = tempDir()
    put(src, 'agents/ok.md', 'ok')
    put(src, 'agents/locked.md', 'locked')
    chmodSync(join(src, 'agents/locked.md'), 0o000)
    put(dst, 'agents/mine.md', 'mine')
    try {
      await expect(importProfile(src, dst, ['agents'])).rejects.toThrow(/agents/)
    } finally {
      chmodSync(join(src, 'agents/locked.md'), 0o644)
    }
    expect(read(dst, 'agents/mine.md')).toBe('mine')
    expect(existsSync(join(dst, 'agents.claudedeck-tmp'))).toBe(false)
    expect(existsSync(join(dst, 'claudedeck'))).toBe(false)
  })

  it('reports which category failed', async () => {
    const src = tempDir()
    const dst = tempDir()
    put(src, 'commands/locked.md', 'x')
    chmodSync(join(src, 'commands/locked.md'), 0o000)
    try {
      const error: unknown = await importProfile(src, dst, ['commands']).catch((e) => e)
      expect(error).toBeInstanceOf(ProfileImportError)
      expect((error as ProfileImportError).category).toBe('commands')
    } finally {
      chmodSync(join(src, 'commands/locked.md'), 0o644)
    }
    expect(existsSync(join(dst, 'commands'))).toBe(false)
  })
})

describe('instructions', () => {
  it('ignores a target CLAUDE.md that only holds the app import line', async () => {
    const src = tempDir()
    const dst = tempDir()
    put(src, 'CLAUDE.md', '# Mine\n')
    put(dst, 'CLAUDE.md', '@claudedeck/guidelines.md\n')
    const by = Object.fromEntries((await diffProfile(src, dst)).map((d) => [d.category, d]))
    expect(by.instructions).toMatchObject({ added: 1, changed: 0, removed: 0 })
    expect((await diffProfile(src, dst)).some((d) => d.changed > 0 || d.removed > 0)).toBe(false)
  })

  it('shows no changes right after importing', async () => {
    const src = makeSource()
    const dst = tempDir()
    put(dst, 'settings.json', JSON.stringify({ theme: 'dark' }))
    await importProfile(src, dst, ALL)
    for (const entry of await diffProfile(src, dst)) {
      expect(entry).toEqual({ category: entry.category, added: 0, changed: 0, removed: 0 })
    }
  })

  it('copies relative @imports that stay inside the source profile', async () => {
    const parent = tempDir()
    const src = join(parent, 'src')
    const dst = tempDir()
    put(
      src,
      'CLAUDE.md',
      [
        '# Rules',
        '@docs/style.md',
        '  @rules/a.md trailing words',
        '@/etc/hosts',
        '@~/global.md',
        '@../outside.md',
        '@missing.md',
        '@.credentials.json',
        '@claudedeck/guidelines.md',
        '```',
        '@code/x.md',
        '```',
        ''
      ].join('\n')
    )
    put(src, 'docs/style.md', 'style')
    put(src, 'rules/a.md', 'rule a')
    put(src, 'code/x.md', 'code')
    put(src, '.credentials.json', 'secret')
    put(src, 'claudedeck/guidelines.md', 'theirs')
    put(parent, 'outside.md', 'outside')
    put(dst, 'docs/style.md', 'old style')
    const result = await importProfile(src, dst, ['instructions'])
    expect(read(dst, 'docs/style.md')).toBe('style')
    expect(read(dst, 'rules/a.md')).toBe('rule a')
    expect(read(result.backupDir ?? '', 'docs/style.md')).toBe('old style')
    for (const rel of ['code/x.md', '.credentials.json', 'claudedeck/guidelines.md']) {
      expect(existsSync(join(dst, rel))).toBe(false)
    }
    expect(existsSync(join(parent, 'outside.md'))).toBe(true)
    expect(read(dst, 'CLAUDE.md')).toContain('@claudedeck/guidelines.md')
  })
})

describe('@import canonicalisation', () => {
  it('skips an import whose link leads outside the source profile', async () => {
    const parent = tempDir()
    const src = join(parent, 'src')
    const dst = tempDir()
    put(src, 'CLAUDE.md', '# Rules\n@docs/escape.md\n@docs/alias.md\n@docs/ok.md\n')
    put(parent, 'secret.txt', 'outside secret')
    put(src, '.credentials.json', 'secret')
    put(src, 'docs/ok.md', 'ok')
    symlinkSync(join(parent, 'secret.txt'), join(src, 'docs', 'escape.md'))
    symlinkSync(join(src, '.credentials.json'), join(src, 'docs', 'alias.md'))
    await importProfile(src, dst, ['instructions'])
    expect(read(dst, 'docs/ok.md')).toBe('ok')
    expect(existsSync(join(dst, 'docs', 'escape.md'))).toBe(false)
    expect(existsSync(join(dst, 'docs', 'alias.md'))).toBe(false)
  })

  it('applies the Windows name rules', () => {
    for (const ref of [
      'docs/style.md',
      './docs/style.md',
      '../src/docs/x.md',
      'rules\\a.md',
      'a.b/c.md'
    ]) {
      expect(importRefAllowed(ref, 'win32')).toBe(true)
    }
    for (const ref of [
      'C:\\x.md',
      'C:x.md',
      '\\\\server\\share\\x.md',
      '~/x.md',
      'SETTIN~1.JSO',
      'docs/PROGRA~1/x.md',
      'docs/x.md:secret',
      'settings.json.',
      'settings.json ',
      'docs./x.md',
      'docs /x.md'
    ]) {
      expect(importRefAllowed(ref, 'win32')).toBe(false)
    }
    // POSIX names may hold these characters.
    expect(importRefAllowed('docs/a:b~c.', 'darwin')).toBe(true)
    expect(importRefAllowed('/etc/hosts', 'darwin')).toBe(false)
  })
})
