import { describe, expect, it } from 'vitest'
import {
  checkForUpdate,
  isInstallerFor,
  parseLatestRelease,
  releasePageUrl,
  RELEASES_URL,
  WINDOWS_ARTIFACT_NAME,
  type UpdateTarget
} from './updateChecker'

const url = 'https://github.com/FurkanZhlp/ClaudeDeck/releases/tag/v0.2.0'
const mac: UpdateTarget = { platform: 'darwin', arch: 'arm64' }
const winX64: UpdateTarget = { platform: 'win32', arch: 'x64' }
const winArm: UpdateTarget = { platform: 'win32', arch: 'arm64' }
const assets = (...names: string[]): { name: string }[] => names.map((name) => ({ name }))
const macOnly = assets('claudedeck-0.2.0-arm64.dmg', 'claudedeck-0.2.0-arm64.dmg.blockmap')
const all = assets(
  'claudedeck-0.2.0-arm64.dmg',
  'claudedeck-0.2.0-x64-setup.exe',
  'claudedeck-0.2.0-arm64-setup.exe'
)

describe('parseLatestRelease', () => {
  it('daha yeni sürümü bildirir', () => {
    expect(
      parseLatestRelease({ tag_name: 'v0.2.0', html_url: url, assets: macOnly }, '0.1.0', mac)
    ).toEqual({
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      available: true,
      url
    })
  })
  it('aynı ya da eski sürümde güncelleme yok der', () => {
    expect(
      parseLatestRelease({ tag_name: 'v0.1.0', html_url: url, assets: all }, '0.1.0', mac).available
    ).toBe(false)
  })
  it('başka adrese yönlendiren html_url değerini kullanmaz', () => {
    expect(
      parseLatestRelease(
        { tag_name: 'v9.0.0', html_url: 'https://evil.example/x', assets: all },
        '0.1.0',
        mac
      ).url
    ).toBe(RELEASES_URL)
  })
  it('boş yanıtta güncelleme yok der', () => {
    expect(parseLatestRelease(null, '0.1.0', mac)).toMatchObject({
      available: false,
      latestVersion: null
    })
  })
  it('hides a release without the Windows installer from Windows only', () => {
    const release = { tag_name: 'v0.2.0', html_url: url, assets: macOnly }
    expect(parseLatestRelease(release, '0.1.0', winX64).available).toBe(false)
    expect(parseLatestRelease(release, '0.1.0', mac).available).toBe(true)
  })
  it('keeps the macOS behaviour: no asset check while the .dmg is still uploading', () => {
    expect(parseLatestRelease({ tag_name: 'v0.2.0', assets: [] }, '0.1.0', mac).available).toBe(
      true
    )
    expect(parseLatestRelease({ tag_name: 'v0.2.0' }, '0.1.0', mac).available).toBe(true)
  })
  it('matches the Windows installer for the running architecture only', () => {
    const x64Only = assets('claudedeck-0.2.0-x64-setup.exe')
    const release = { tag_name: 'v0.2.0', html_url: url, assets: x64Only }
    expect(parseLatestRelease(release, '0.1.0', winX64).available).toBe(true)
    expect(parseLatestRelease(release, '0.1.0', winArm).available).toBe(false)
    expect(parseLatestRelease({ ...release, assets: all }, '0.1.0', winArm).available).toBe(true)
  })
  it('treats missing or malformed assets as no installer on Windows', () => {
    expect(parseLatestRelease({ tag_name: 'v0.2.0' }, '0.1.0', winX64).available).toBe(false)
    expect(
      parseLatestRelease({ tag_name: 'v0.2.0', assets: [null, 3, {}] }, '0.1.0', winX64).available
    ).toBe(false)
  })
  it('ignores drafts even with installers', () => {
    expect(
      parseLatestRelease({ tag_name: 'v0.2.0', draft: true, assets: all }, '0.1.0', mac).available
    ).toBe(false)
  })
  it('falls back to the releases page for an unsafe html_url', () => {
    const release = { tag_name: 'v0.2.0', html_url: `${url}/../../../../evil` }
    expect(parseLatestRelease(release, '0.1.0', mac).url).toBe(RELEASES_URL)
  })
})

describe('releasePageUrl', () => {
  it('accepts release pages of this repo', () => {
    expect(releasePageUrl(url)).toBe(url)
    expect(releasePageUrl(RELEASES_URL)).toBe(RELEASES_URL)
  })
  it('rejects other schemes, hosts, ports, credentials and repos', () => {
    for (const bad of [
      'http://github.com/FurkanZhlp/ClaudeDeck/releases/tag/v1',
      'https://github.com.evil.example/FurkanZhlp/ClaudeDeck/releases/tag/v1',
      'https://github.com:8443/FurkanZhlp/ClaudeDeck/releases/tag/v1',
      'https://user:pw@github.com/FurkanZhlp/ClaudeDeck/releases/tag/v1',
      'https://github.com/Other/ClaudeDeck/releases/tag/v1',
      'https://github.com/FurkanZhlp/ClaudeDeck/releases',
      'javascript:alert(1)',
      'not a url',
      42
    ]) {
      expect(releasePageUrl(bad)).toBeNull()
    }
  })
  it('rejects paths that leave the releases folder after normalisation', () => {
    expect(
      releasePageUrl('https://github.com/FurkanZhlp/ClaudeDeck/releases/../../Other/x')
    ).toBeNull()
    expect(
      releasePageUrl('https://github.com/FurkanZhlp/ClaudeDeck/releases/%2e%2e/%2E%2E/Other')
    ).toBeNull()
  })
})

describe('isInstallerFor', () => {
  it('pins the electron-builder nsis.artifactName it relies on', () => {
    expect(WINDOWS_ARTIFACT_NAME).toBe('${name}-${version}-${arch}-setup.${ext}')
  })
  it('recognises the Windows installer for the arch only', () => {
    expect(isInstallerFor('claudedeck-0.2.0-arm64.dmg', mac)).toBe(false)
    expect(isInstallerFor('ClaudeDeck-0.3.0-X64-Setup.exe', winX64)).toBe(true)
    expect(isInstallerFor('claudedeck-0.3.0-x64-setup.exe.blockmap', winX64)).toBe(false)
    expect(isInstallerFor('latest.yml', winX64)).toBe(false)
    expect(
      isInstallerFor('claudedeck-0.3.0-x64-setup.exe', { platform: 'linux', arch: 'x64' })
    ).toBe(false)
  })
})

describe('checkForUpdate', () => {
  it('404 yanıtını "release yok" olarak yorumlar', async () => {
    const fetchFn = (async () => new Response('{}', { status: 404 })) as typeof fetch
    expect((await checkForUpdate('0.1.0', fetchFn, mac)).available).toBe(false)
  })
  it('diğer hata kodlarında hata fırlatır', async () => {
    const fetchFn = (async () => new Response('{}', { status: 500 })) as typeof fetch
    await expect(checkForUpdate('0.1.0', fetchFn, mac)).rejects.toThrow('GitHub 500')
  })
  it('passes the target through to the asset check', async () => {
    const body = JSON.stringify({ tag_name: 'v0.2.0', html_url: url, assets: macOnly })
    const fetchFn = (async () => new Response(body, { status: 200 })) as typeof fetch
    expect((await checkForUpdate('0.1.0', fetchFn, mac)).available).toBe(true)
    expect((await checkForUpdate('0.1.0', fetchFn, winX64)).available).toBe(false)
  })
})
