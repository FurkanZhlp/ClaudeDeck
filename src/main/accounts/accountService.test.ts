import { describe, expect, it } from 'vitest'
import { accountDir, parseAuthStatus } from './accountService'

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
    expect(accountDir('/a/accounts', id)).toBe(`/a/accounts/${id}`)
  })
  it('UUID olmayan kimliği reddeder', () => {
    expect(() => accountDir('/a/accounts', '../x')).toThrowError('INVALID')
    expect(() => accountDir('/a/accounts', '')).toThrowError('INVALID')
  })
})
