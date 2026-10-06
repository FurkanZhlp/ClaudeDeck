import { describe, expect, it } from 'vitest'
import {
  buildSessionEnv,
  claudeCommand,
  parseEnvOutput,
  sanitizeEnv,
  withFallbackPath
} from './shellEnv'

describe('parseEnvOutput', () => {
  it('işaretçiden sonraki NUL ayrımlı değişkenleri okur', () => {
    const out = 'motd çıktısı\n__CLAUDEDECK_ENV__PATH=/usr/bin\0HOME=/Users/x\0EQ=a=b\0'
    expect(parseEnvOutput(out)).toEqual({ PATH: '/usr/bin', HOME: '/Users/x', EQ: 'a=b' })
  })
  it('işaretçi yoksa boş nesne döner', () => {
    expect(parseEnvOutput('PATH=/bin')).toEqual({})
  })
})

describe('sanitizeEnv', () => {
  it('tanımsızları ve Claude Code iç değişkenlerini atar', () => {
    expect(
      sanitizeEnv({
        PATH: '/bin',
        CLAUDECODE: '1',
        CLAUDE_CONFIG_DIR: '/x',
        ANTHROPIC_API_KEY: 'k',
        U: undefined
      })
    ).toEqual({ PATH: '/bin' })
  })
})

describe('withFallbackPath', () => {
  it('eksik yaygın dizinleri PATH sonuna ekler, var olanı tekrarlamaz', () => {
    expect(withFallbackPath({ PATH: '/usr/bin:/opt/homebrew/bin' }, '/Users/x').PATH).toBe(
      '/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/x/.local/bin'
    )
  })
})

describe('buildSessionEnv', () => {
  it('hesabın config klasörünü ve terminal değişkenlerini ekler', () => {
    expect(buildSessionEnv({ PATH: '/bin' }, { configDir: '/acc/1' })).toEqual({
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: '/acc/1',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'ClaudeDeck',
      LANG: 'en_US.UTF-8'
    })
  })
  it('mevcut LANG değerini korur', () => {
    expect(buildSessionEnv({ LANG: 'tr_TR.UTF-8' }, { configDir: '/a' }).LANG).toBe('tr_TR.UTF-8')
  })
})

describe('claudeCommand', () => {
  it('kimlik değişkenlerini kaldırır, config klasörünü ve argümanları tırnaklar', () => {
    expect(claudeCommand("/a/b c'd", ['--resume', 'x'])).toBe(
      'exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN ' +
        "CLAUDE_CONFIG_DIR='/a/b c'\\''d' claude '--resume' 'x'"
    )
  })
})
