import { describe, expect, it } from 'vitest'
import {
  buildSessionEnv,
  claudeCommand,
  getEnv,
  normalizeWindowsEnv,
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
  it('strips Anthropic profile and federation variables', () => {
    expect(
      sanitizeEnv({
        PATH: '/bin',
        ANTHROPIC_PROFILE: 'p',
        ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_x',
        ANTHROPIC_ORGANIZATION_ID: 'o',
        ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_x',
        ANTHROPIC_IDENTITY_TOKEN: 'jwt',
        ANTHROPIC_IDENTITY_TOKEN_FILE: '/t',
        ANTHROPIC_WORKSPACE_ID: 'w'
      })
    ).toEqual({ PATH: '/bin' })
  })
  it('strips endpoint and provider switches that could redirect the token', () => {
    const env = {
      PATH: '/bin',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
      ANTHROPIC_CUSTOM_HEADERS: 'X-A: 1',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      AWS_BEARER_TOKEN_BEDROCK: 'b'
    }
    expect(sanitizeEnv(env)).toEqual({ PATH: '/bin' })
    expect(sanitizeEnv({ ...env, PATH: 'C:\\a', anthropic_base_url: 'x' }, 'win32')).toEqual({
      Path: 'C:\\a'
    })
  })
  it('keeps case-different names on POSIX', () => {
    expect(sanitizeEnv({ anthropic_api_key: 'k' })).toEqual({ anthropic_api_key: 'k' })
  })
  it('strips in any case and merges Path on Windows', () => {
    expect(
      sanitizeEnv(
        {
          Path: 'C:\\a',
          PATH: 'C:\\b;C:\\A',
          anthropic_api_key: 'k',
          Claude_Config_Dir: 'x',
          Home: 'h'
        },
        'win32'
      )
    ).toEqual({ Path: 'C:\\a;C:\\b', Home: 'h' })
  })
})

describe('normalizeWindowsEnv', () => {
  it('keeps the first spelling and the last value', () => {
    expect(normalizeWindowsEnv({ Temp: 'a', TEMP: 'b', path: 'x' })).toEqual({
      Temp: 'b',
      Path: 'x'
    })
  })
})

describe('getEnv', () => {
  it('matches names case-insensitively only on Windows', () => {
    expect(getEnv({ SystemRoot: 'C:\\W' }, 'SYSTEMROOT', 'win32')).toBe('C:\\W')
    expect(getEnv({ SystemRoot: 'C:\\W' }, 'SYSTEMROOT')).toBeUndefined()
  })
})

describe('withFallbackPath', () => {
  it('eksik yaygın dizinleri PATH sonuna ekler, var olanı tekrarlamaz', () => {
    expect(withFallbackPath({ PATH: '/usr/bin:/opt/homebrew/bin' }, '/Users/x').PATH).toBe(
      '/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/x/.local/bin'
    )
  })
  it('uses ; and the Windows install dirs, case-insensitively', () => {
    const env = withFallbackPath(
      { PATH: 'C:\\Windows;c:\\users\\x\\.local\\bin\\', LOCALAPPDATA: 'D:\\Local' },
      'C:\\Users\\x',
      'win32'
    )
    expect(env).toEqual({
      LOCALAPPDATA: 'D:\\Local',
      Path: [
        'C:\\Windows',
        'c:\\users\\x\\.local\\bin\\',
        'C:\\Users\\x\\AppData\\Roaming\\npm',
        'D:\\Local\\Microsoft\\WinGet\\Links'
      ].join(';')
    })
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
        '-u ANTHROPIC_PROFILE -u ANTHROPIC_FEDERATION_RULE_ID -u ANTHROPIC_ORGANIZATION_ID ' +
        '-u ANTHROPIC_SERVICE_ACCOUNT_ID -u ANTHROPIC_IDENTITY_TOKEN ' +
        '-u ANTHROPIC_IDENTITY_TOKEN_FILE -u ANTHROPIC_WORKSPACE_ID ' +
        // Endpoint and provider switches (deliberate: subscription accounts only).
        '-u ANTHROPIC_BASE_URL -u ANTHROPIC_CUSTOM_HEADERS -u CLAUDE_CODE_USE_BEDROCK ' +
        '-u CLAUDE_CODE_USE_VERTEX -u CLAUDE_CODE_USE_FOUNDRY -u CLAUDE_CODE_USE_MANTLE -u CLAUDE_CODE_USE_ANTHROPIC_AWS -u ANTHROPIC_BEDROCK_BASE_URL -u ANTHROPIC_VERTEX_BASE_URL -u AWS_BEARER_TOKEN_BEDROCK ' +
        "CLAUDE_CONFIG_DIR='/a/b c'\\''d' claude '--resume' 'x'"
    )
  })
})
