import { mkdtempSync } from 'node:fs'
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
