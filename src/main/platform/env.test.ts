import { describe, expect, it } from 'vitest'
import { windowsBaseEnv, withEnvVars } from './env'

describe('windowsBaseEnv', () => {
  it('normalizes the app env and appends the Claude install dirs', () => {
    const env = windowsBaseEnv(
      {
        Path: 'C:\\Windows',
        PATH: 'C:\\Tools;c:\\windows\\',
        USERPROFILE: 'C:\\Users\\me',
        APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
        Anthropic_Auth_Token: 't',
        ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_x',
        CLAUDECODE: '1',
        NODE_OPTIONS: '--x',
        U: undefined
      },
      'C:\\fallback'
    )
    expect(env).toEqual({
      USERPROFILE: 'C:\\Users\\me',
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
      Path: [
        'C:\\Windows',
        'C:\\Tools',
        'C:\\Users\\me\\.local\\bin',
        'C:\\Users\\me\\AppData\\Roaming\\npm',
        'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links'
      ].join(';')
    })
  })

  it('uses the given home without USERPROFILE', () => {
    expect(windowsBaseEnv({}, 'C:\\h').Path.split(';')[0]).toBe('C:\\h\\.local\\bin')
  })
})

describe('withEnvVars', () => {
  it('replaces other spellings of the names on Windows', () => {
    expect(
      withEnvVars({ Path: 'C:\\x', mcp_tool_timeout: '5' }, { MCP_TOOL_TIMEOUT: '9' }, 'win32')
    ).toEqual({
      Path: 'C:\\x',
      MCP_TOOL_TIMEOUT: '9'
    })
  })

  it('is a plain merge elsewhere', () => {
    expect(withEnvVars({ a: '1', A: '2' }, { a: '3' }, 'darwin')).toEqual({ a: '3', A: '2' })
  })
})
