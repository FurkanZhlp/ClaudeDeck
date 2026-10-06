import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeProjectKey, encodeProjectPath, memoryDir, resolveMemoryKey } from './memoryPath'

const LONG =
  '/private/tmp/claude-501/-Volumes-Furkan-SSD-Projects-Furkan-CoreTechs/b20d8270-03af-4e10-9ba1-e05594e495e8/scratchpad/gitroot/long/segment-number-01/segment-number-02/segment-number-03/segment-number-04/segment-number-05/segment-number-06/segment-number-07/segment-number-08/segment-number-09'

describe('encodeProjectKey', () => {
  it('encodes paths like Claude Code, including non-ASCII characters', () => {
    expect(encodeProjectKey('/Users/me/Boen Proje Dosyaları/BoenCV')).toBe(
      '-Users-me-Boen-Proje-Dosyalar--BoenCV'
    )
    expect(encodeProjectPath).toBe(encodeProjectKey)
  })

  it('keeps names up to 200 chars as they are', () => {
    const path = `/${'a'.repeat(199)}`
    expect(encodeProjectKey(path)).toBe(`-${'a'.repeat(199)}`)
  })

  it('cuts long names and appends the hash of the raw path', () => {
    const name = encodeProjectKey(LONG)
    expect(name).toHaveLength(207)
    expect(name.endsWith('-x76oab')).toBe(true)
    expect(name.slice(0, 200)).toBe(LONG.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200))
  })

  it('uses the absolute value of a negative hash', () => {
    expect(encodeProjectKey(`${LONG}/neg0`).endsWith('-1bt2ro')).toBe(true)
  })
})

describe('resolveMemoryKey', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'claudedeck-key-')))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('uses the git root for nested folders', () => {
    const repo = join(root, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'packages', 'web'), { recursive: true })
    expect(resolveMemoryKey(join(repo, 'packages', 'web'))).toBe(repo)
    expect(resolveMemoryKey(repo)).toBe(repo)
  })

  it('counts a .git file (worktree or submodule) as a root', () => {
    const outer = join(root, 'outer')
    const worktree = join(outer, 'wt')
    mkdirSync(join(outer, '.git'), { recursive: true })
    mkdirSync(join(worktree, 'src'), { recursive: true })
    writeFileSync(join(worktree, '.git'), 'gitdir: /somewhere\n')
    expect(resolveMemoryKey(join(worktree, 'src'))).toBe(worktree)
  })

  it('falls back to the real path outside a repository and resolves symlinks', () => {
    const plain = join(root, 'plain', 'app')
    mkdirSync(plain, { recursive: true })
    const link = join(root, 'link')
    symlinkSync(plain, link)
    // tmpdir may itself sit inside a repo on some machines; only assert when it does not.
    if (resolveMemoryKey(plain) === plain) expect(resolveMemoryKey(link)).toBe(plain)
  })

  it('keeps a missing path as given', () => {
    expect(resolveMemoryKey('/definitely/missing/claudedeck-app')).toBe(
      '/definitely/missing/claudedeck-app'
    )
  })

  it('builds the memory folder from the key', () => {
    const repo = join(root, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'web'))
    expect(memoryDir('/cfg', join(repo, 'web'))).toBe(
      join('/cfg', 'projects', encodeProjectKey(repo), 'memory')
    )
  })
})
