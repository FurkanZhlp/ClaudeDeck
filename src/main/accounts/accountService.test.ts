import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodeProjectKey } from '../notes/memoryPath'
import {
  AccountService,
  accountDir,
  hasConversation,
  markOnboardingComplete,
  parseAuthStatus,
  transcriptPath
} from './accountService'

describe('parseAuthStatus', () => {
  it('giriş durumunu ve e-postayı okur', () => {
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.co"}')).toEqual({
      loggedIn: true,
      email: 'a@b.co'
    })
  })
  it('giriş yoksa loggedIn false döner', () => {
    expect(parseAuthStatus('{"loggedIn": false, "authMethod": "none"}')).toEqual({
      loggedIn: false
    })
  })
  it('JSON öncesindeki gürültüyü tolere eder', () => {
    expect(parseAuthStatus('Uyarı: x\n{"loggedIn":true}').loggedIn).toBe(true)
  })
  it('geçersiz çıktıyı giriş yok sayar', () => {
    expect(parseAuthStatus('zsh: command not found: claude')).toEqual({ loggedIn: false })
  })
})

describe('accountDir', () => {
  it('UUID kimlikten hesap klasörünü türetir', () => {
    const id = '5ef4bfc8-45fe-43c9-b57e-20b2397975b7'
    expect(accountDir('/a/accounts', id)).toBe(join('/a/accounts', id))
  })
  it('UUID olmayan kimliği reddeder', () => {
    expect(() => accountDir('/a/accounts', '../x')).toThrowError('INVALID')
    expect(() => accountDir('/a/accounts', '')).toThrowError('INVALID')
  })
})

describe('markOnboardingComplete', () => {
  const setup = (content?: object): string => {
    const dir = mkdtempSync(join(tmpdir(), 'claudedeck-onboarding-'))
    if (content) writeFileSync(join(dir, '.claude.json'), JSON.stringify(content))
    return dir
  }
  const read = (dir: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'))

  it('marks a signed-in config as onboarded and keeps other keys', () => {
    const dir = setup({ oauthAccount: { emailAddress: 'a@b.co' }, userID: 'x' })
    expect(markOnboardingComplete(dir)).toBe(true)
    expect(read(dir)).toEqual({
      oauthAccount: { emailAddress: 'a@b.co' },
      userID: 'x',
      hasCompletedOnboarding: true
    })
  })
  it('leaves signed-out configs alone so onboarding can ask for a login', () => {
    const dir = setup({ userID: 'x' })
    expect(markOnboardingComplete(dir)).toBe(false)
    expect(read(dir)).toEqual({ userID: 'x' })
  })
  it('does nothing when already onboarded or the file is missing', () => {
    expect(markOnboardingComplete(setup({ oauthAccount: {}, hasCompletedOnboarding: true }))).toBe(
      false
    )
    expect(markOnboardingComplete(setup())).toBe(false)
  })
})

describe('hasConversation', () => {
  it('encodes the project path like Claude Code', () => {
    expect(transcriptPath('/cfg', '/Volumes/My SSD/web-app', 'id')).toBe(
      join('/cfg', 'projects', '-Volumes-My-SSD-web-app', 'id.jsonl')
    )
  })
  it('encodes Windows paths and long paths with the shared project key', () => {
    expect(transcriptPath('/cfg', 'C:\\Users\\x\\p', 'id')).toBe(
      join('/cfg', 'projects', 'C--Users-x-p', 'id.jsonl')
    )
    const long = `/${'a'.repeat(250)}`
    expect(transcriptPath('/cfg', long, 'id')).toBe(
      join('/cfg', 'projects', encodeProjectKey(long), 'id.jsonl')
    )
  })
  it('is true only once the transcript file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claudedeck-transcript-'))
    expect(hasConversation(dir, '/tmp/app', 'abc')).toBe(false)
    const file = transcriptPath(dir, '/tmp/app', 'abc')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{}\n')
    expect(hasConversation(dir, '/tmp/app', 'abc')).toBe(true)
  })
})

describe('AccountService.claudeAvailable', () => {
  it('asks the locator with the base env', async () => {
    const seen: Record<string, string>[] = []
    const service = new AccountService('/accounts', () => Promise.resolve({ PATH: '/x' }), {
      available: (env) => {
        seen.push(env)
        return Promise.resolve(false)
      },
      file: () => Promise.resolve('claude')
    })
    await expect(service.claudeAvailable()).resolves.toBe(false)
    expect(seen).toEqual([{ PATH: '/x' }])
  })
})
