import { describe, expect, it } from 'vitest'
import { checkForUpdate, parseLatestRelease, RELEASES_URL } from './updateChecker'

const url = 'https://github.com/FurkanZhlp/ClaudeDeck/releases/tag/v0.2.0'

describe('parseLatestRelease', () => {
  it('daha yeni sürümü bildirir', () => {
    expect(parseLatestRelease({ tag_name: 'v0.2.0', html_url: url }, '0.1.0')).toEqual({
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      available: true,
      url
    })
  })
  it('aynı ya da eski sürümde güncelleme yok der', () => {
    expect(parseLatestRelease({ tag_name: 'v0.1.0', html_url: url }, '0.1.0').available).toBe(false)
  })
  it('başka adrese yönlendiren html_url değerini kullanmaz', () => {
    expect(
      parseLatestRelease({ tag_name: 'v9.0.0', html_url: 'https://evil.example/x' }, '0.1.0').url
    ).toBe(RELEASES_URL)
  })
  it('boş yanıtta güncelleme yok der', () => {
    expect(parseLatestRelease(null, '0.1.0')).toMatchObject({
      available: false,
      latestVersion: null
    })
  })
})

describe('checkForUpdate', () => {
  it('404 yanıtını "release yok" olarak yorumlar', async () => {
    const fetchFn = (async () => new Response('{}', { status: 404 })) as typeof fetch
    expect((await checkForUpdate('0.1.0', fetchFn)).available).toBe(false)
  })
  it('diğer hata kodlarında hata fırlatır', async () => {
    const fetchFn = (async () => new Response('{}', { status: 500 })) as typeof fetch
    await expect(checkForUpdate('0.1.0', fetchFn)).rejects.toThrow('GitHub 500')
  })
})
