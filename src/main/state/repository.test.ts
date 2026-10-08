import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '../../shared/types'
import { JsonStore } from './jsonStore'
import { emptyState, Repository } from './repository'

let dir: string
let n: number

const make = (): Repository =>
  new Repository(
    new JsonStore<AppState>(join(dir, 'config.json'), emptyState),
    join(dir, 'accounts'),
    () => `id${++n}`
  )

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudedeck-repo-'))
  n = 0
})

describe('Repository', () => {
  it('hesabın config klasörünü hesap kökü altına koyar ve adı kırpar', () => {
    const { account } = make().createAccount({ name: ' İş ', color: '#2563eb' })
    expect(account).toEqual({
      id: 'id1',
      name: 'İş',
      color: '#2563eb',
      configDir: join(dir, 'accounts', 'id1')
    })
  })

  it('durumu diske yazar, yeni örnek aynı durumu yükler', () => {
    make().createAccount({ name: 'A', color: '#000' })
    expect(
      make()
        .get()
        .accounts.map((a) => a.name)
    ).toEqual(['A'])
  })

  it('boş adı reddeder', () => {
    expect(() => make().createAccount({ name: '  ', color: '#000' })).toThrowError('INVALID')
  })

  it('göreli proje yolunu reddeder', () => {
    const repo = make()
    const { account } = repo.createAccount({ name: 'A', color: '#000' })
    expect(() =>
      repo.createProject({ name: 'P', path: 'tmp', accountId: account.id })
    ).toThrowError('INVALID')
  })

  it('e-postayı açıkça temizleyebilir', () => {
    const repo = make()
    const { account } = repo.createAccount({ name: 'A', color: '#000' })
    repo.updateAccount(account.id, { email: 'a@b.co' })
    expect(repo.updateAccount(account.id, { email: undefined }).accounts[0].email).toBeUndefined()
  })

  it('olmayan hesapla proje oluşturmayı reddeder', () => {
    expect(() => make().createProject({ name: 'P', path: '/tmp', accountId: 'yok' })).toThrowError(
      'NOT_FOUND'
    )
  })

  it('projeye atanmış hesabın silinmesini engeller', () => {
    const repo = make()
    const { account } = repo.createAccount({ name: 'A', color: '#000' })
    repo.createProject({ name: 'P', path: '/tmp', accountId: account.id })
    expect(() => repo.removeAccount(account.id)).toThrowError('ACCOUNT_IN_USE')
  })

  it('silinen hesap menü çubuğunda seçiliyse otomatiğe döner', () => {
    const repo = make()
    const a = repo.createAccount({ name: 'A', color: '#000' }).account
    const b = repo.createAccount({ name: 'B', color: '#111' }).account
    repo.setUsageSettings({ trayAccount: b.id })
    expect(repo.removeAccount(a.id).settings.usage.trayAccount).toBe(b.id)
    expect(repo.removeAccount(b.id).settings.usage.trayAccount).toBe('auto')
  })

  it('proje hesabını değiştirir', () => {
    const repo = make()
    const a = repo.createAccount({ name: 'A', color: '#000' }).account
    const b = repo.createAccount({ name: 'B', color: '#111' }).account
    repo.createProject({ name: 'P', path: '/tmp', accountId: a.id })
    const projectId = repo.get().projects[0].id
    expect(repo.updateProject(projectId, { accountId: b.id }).projects[0].accountId).toBe(b.id)
    expect(() => repo.updateProject(projectId, { accountId: 'yok' })).toThrowError('NOT_FOUND')
  })

  it('proje silinince oturumlarını da siler ve id listesini döner', () => {
    const repo = make()
    const { account } = repo.createAccount({ name: 'A', color: '#000' })
    repo.createProject({ name: 'P', path: '/tmp', accountId: account.id })
    const projectId = repo.get().projects[0].id
    const { session } = repo.createSession(projectId, 'claude', 'Claude 1')
    const { state, removedSessionIds } = repo.removeProject(projectId)
    expect(removedSessionIds).toEqual([session.id])
    expect(state.sessions).toEqual([])
  })

  it('geçersiz oturum türünü reddeder', () => {
    const repo = make()
    const { account } = repo.createAccount({ name: 'A', color: '#000' })
    repo.createProject({ name: 'P', path: '/tmp', accountId: account.id })
    const projectId = repo.get().projects[0].id
    expect(() => repo.createSession(projectId, 'x' as 'claude', 'T')).toThrowError('INVALID')
  })

  it('dil ayarını doğrular', () => {
    const repo = make()
    expect(repo.setLanguage('en').settings.language).toBe('en')
    expect(repo.setLanguage(null).settings.language).toBeNull()
    expect(() => repo.setLanguage('de' as 'en')).toThrowError('INVALID')
  })
})

describe('settings', () => {
  it('fills usage and login defaults for configs written by older versions', () => {
    const file = join(dir, 'config.json')
    writeFileSync(
      file,
      JSON.stringify({ accounts: [], projects: [], sessions: [], settings: { language: 'tr' } })
    )
    const settings = make().get().settings
    expect(settings.language).toBe('tr')
    expect(settings.usage).toEqual({
      display: 'used',
      trayEnabled: true,
      trayMetric: 'both',
      trayAccount: 'auto'
    })
    expect(settings.launchAtLogin).toBe(false)
    expect(settings.testQueue).toEqual({
      enabled: false,
      mode: 'auto',
      maxConcurrent: 2,
      auto: {
        maxConcurrent: null,
        cpuHighPercent: 85,
        cpuResumePercent: 65,
        minAvailableMemoryPercent: 15,
        rampUpSeconds: 20
      },
      maxWaitMinutes: 60,
      startGraceSeconds: 120,
      backgroundMaxHoldMinutes: 30,
      disabledBuiltins: [],
      customPatterns: []
    })
  })

  it('deep merges test queue settings saved by older versions', () => {
    const file = join(dir, 'config.json')
    writeFileSync(
      file,
      JSON.stringify({
        accounts: [],
        projects: [],
        sessions: [],
        settings: { testQueue: { enabled: true, auto: { rampUpSeconds: 5 } } }
      })
    )
    const { testQueue } = make().get().settings
    expect(testQueue.enabled).toBe(true)
    expect(testQueue.maxWaitMinutes).toBe(60)
    expect(testQueue.auto).toMatchObject({ rampUpSeconds: 5, cpuHighPercent: 85 })
  })

  it('saves test queue settings with generated pattern ids', () => {
    const repo = make()
    const state = repo.setTestQueueSettings({
      enabled: true,
      mode: 'fixed',
      maxConcurrent: 0,
      customPatterns: [{ id: '', kind: 'prefix', pattern: 'make e2e' }]
    })
    expect(state.settings.testQueue).toMatchObject({
      enabled: true,
      mode: 'fixed',
      maxConcurrent: 1,
      customPatterns: [{ id: 'id1', kind: 'prefix', pattern: 'make e2e' }]
    })
    expect(make().get().settings.testQueue.mode).toBe('fixed')
    expect(() =>
      repo.setTestQueueSettings({ customPatterns: [{ id: 'x', kind: 'regex', pattern: '[' }] })
    ).toThrowError('INVALID')
  })

  it('stores project test queue overrides and drops them when back to defaults', () => {
    const repo = make()
    const { account } = repo.createAccount({ name: 'A', color: '#000' })
    const projectId = repo.createProject({ name: 'P', path: dir, accountId: account.id })
      .projects[0].id
    expect(repo.setProjectTestQueue(projectId, { mode: 'off' }).projects[0].testQueue).toEqual({
      mode: 'off',
      disabledBuiltins: [],
      customPatterns: []
    })
    expect(repo.updateProject(projectId, { name: 'Q' }).projects[0].testQueue?.mode).toBe('off')
    expect(repo.setProjectTestQueue(projectId, { mode: 'inherit' }).projects[0]).not.toHaveProperty(
      'testQueue'
    )
    expect(() => repo.setProjectTestQueue('missing', { mode: 'off' })).toThrowError('NOT_FOUND')
  })
  it('validates usage settings', () => {
    const repo = make()
    expect(
      repo.setUsageSettings({ display: 'remaining', trayMetric: 'weekly' }).settings.usage
    ).toMatchObject({ display: 'remaining', trayMetric: 'weekly' })
    expect(() => repo.setUsageSettings({ display: 'x' as 'used' })).toThrowError('INVALID')
    expect(() => repo.setUsageSettings({ trayAccount: 'missing' })).toThrowError('NOT_FOUND')
    expect(repo.setLaunchAtLogin(true).settings.launchAtLogin).toBe(true)
  })
})

describe('Claude permission modes', () => {
  const withProject = (): { repo: Repository; projectId: string } => {
    const repo = make()
    const { account } = repo.createAccount({ name: 'A', color: '#000' })
    repo.createProject({ name: 'P', path: '/tmp', accountId: account.id })
    return { repo, projectId: repo.get().projects[0].id }
  }

  it('defaults configs written by older versions to no flag and no bypass', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ accounts: [], projects: [], sessions: [], settings: { language: 'tr' } })
    )
    expect(make().get().settings.claude).toEqual({ permissionMode: 'default', allowBypass: false })
  })

  it('replaces hand-edited unknown values with defaults', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        accounts: [],
        projects: [],
        sessions: [],
        settings: { claude: { permissionMode: 'yolo', allowBypass: 'yes' } }
      })
    )
    expect(make().get().settings.claude).toEqual({ permissionMode: 'default', allowBypass: false })
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        accounts: [],
        projects: [],
        sessions: [],
        settings: { claude: { permissionMode: 'acceptEdits' } }
      })
    )
    expect(make().get().settings.claude).toEqual({
      permissionMode: 'acceptEdits',
      allowBypass: false
    })
  })

  it('validates and saves the global settings', () => {
    const repo = make()
    expect(repo.setClaudeSettings({ permissionMode: 'bypassPermissions' }).settings.claude).toEqual(
      { permissionMode: 'bypassPermissions', allowBypass: false }
    )
    expect(repo.setClaudeSettings({ allowBypass: true }).settings.claude.allowBypass).toBe(true)
    expect(() => repo.setClaudeSettings({ permissionMode: 'x' as 'plan' })).toThrowError('INVALID')
    expect(() => repo.setClaudeSettings({ allowBypass: 1 as unknown as boolean })).toThrowError(
      'INVALID'
    )
    expect(make().get().settings.claude).toEqual({
      permissionMode: 'bypassPermissions',
      allowBypass: true
    })
  })

  it('stores a project override and drops it on inherit', () => {
    const { repo, projectId } = withProject()
    expect(repo.setProjectClaude(projectId, { permissionMode: 'plan' }).projects[0].claude).toEqual(
      {
        permissionMode: 'plan'
      }
    )
    expect(() => repo.setProjectClaude(projectId, { permissionMode: 'x' as 'plan' })).toThrowError(
      'INVALID'
    )
    expect(
      repo.setProjectClaude(projectId, { permissionMode: 'inherit' }).projects[0]
    ).not.toHaveProperty('claude')
    expect(() => repo.setProjectClaude('missing', { permissionMode: 'plan' })).toThrowError(
      'NOT_FOUND'
    )
  })

  it('pins a mode on new Claude tabs only', () => {
    const { repo, projectId } = withProject()
    const pinned = repo.createSession(projectId, 'claude', 'C', 'bypassPermissions').session
    expect(pinned.permissionMode).toBe('bypassPermissions')
    expect(repo.createSession(projectId, 'claude', 'C').session).not.toHaveProperty(
      'permissionMode'
    )
    expect(() => repo.createSession(projectId, 'shell', 'T', 'plan')).toThrowError('INVALID')
    expect(() => repo.createSession(projectId, 'claude', 'C', 'x' as 'plan')).toThrowError(
      'INVALID'
    )
    // The pinned mode survives a reload, so resuming the tab keeps it.
    expect(make().session(pinned.id).permissionMode).toBe('bypassPermissions')
  })
})

describe('guard settings', () => {
  it('turns the guard on with default categories for configs written before it existed', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        accounts: [],
        projects: [{ id: 'p', name: 'P', path: '/p', accountId: 'a', guard: { categories: {} } }],
        sessions: [],
        settings: { language: 'tr' }
      })
    )
    const state = make().get()
    expect(state.settings.guard).toEqual({
      enabled: true,
      categories: {
        disk: 'deny',
        sensitive: 'deny',
        git: 'ask',
        fetchExec: 'ask',
        docker: 'ask',
        database: 'ask',
        publish: 'ask',
        system: 'ask'
      },
      ruleOverrides: {},
      customRules: []
    })
    expect(state.projects[0]).not.toHaveProperty('guard')
  })

  it('stores global and project guard settings', () => {
    const repo = make()
    const { account } = repo.createAccount({ name: 'A', color: 'blue' })
    repo.createProject({ name: 'P', path: '/p', accountId: account.id })
    const projectId = repo.get().projects[0].id
    let state = repo.setGuardSettings({
      categories: { git: 'deny' } as never,
      customRules: [{ kind: 'prefix', pattern: ' echo GUARD-SENTINEL-* ', action: 'deny' } as never]
    })
    expect(state.settings.guard.categories.git).toBe('deny')
    expect(state.settings.guard.categories.disk).toBe('deny')
    expect(state.settings.guard.customRules).toEqual([
      { id: 'id3', kind: 'prefix', pattern: 'echo GUARD-SENTINEL-*', action: 'deny' }
    ])
    state = repo.setProjectGuard(projectId, { categories: { docker: 'allow' } })
    expect(state.projects[0].guard).toEqual({
      categories: { docker: 'allow' },
      ruleOverrides: {},
      customRules: []
    })
    expect(make().get().projects[0].guard?.categories).toEqual({ docker: 'allow' })
    state = repo.setProjectGuard(projectId, { categories: {} })
    expect(state.projects[0]).not.toHaveProperty('guard')
    repo.setProjectGuard(projectId, { ruleOverrides: { 'git.forcePush': 'allow' } })
    expect(repo.setProjectGuard(projectId, null).projects[0]).not.toHaveProperty('guard')
  })
})
