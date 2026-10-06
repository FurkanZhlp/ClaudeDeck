import { describe, expect, it } from 'vitest'
import { parseLoginOutput, stripAnsi } from './loginProgress'

const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz'

describe('parseLoginOutput', () => {
  it('starts in the starting stage with no output', () => {
    expect(parseLoginOutput('', null)).toEqual({ stage: 'starting', url: null })
  })

  it('detects the browser stage', () => {
    expect(parseLoginOutput('Opening browser to sign in…\r\n', null).stage).toBe('browser')
  })

  it('extracts the sign-in URL through ANSI link and colour codes', () => {
    const raw = `Opening browser to sign in…\r\nIf the browser didn't open, visit: \x1b]8;;${URL}\x07\x1b[4m${URL}\x1b[24m\x1b]8;;\x07\r\n`
    expect(parseLoginOutput(raw, null)).toEqual({ stage: 'waiting', url: URL })
  })

  it('reports success from the output or a zero exit code', () => {
    expect(parseLoginOutput(`visit: ${URL}\r\nLogin successful.`, null).stage).toBe('success')
    expect(parseLoginOutput('', 0).stage).toBe('success')
  })

  it('reports failure on a non-zero exit without success', () => {
    expect(parseLoginOutput(`visit: ${URL}`, 1)).toEqual({ stage: 'failed', url: URL })
  })

  it('ignores lookalike hosts', () => {
    expect(parseLoginOutput('visit: https://claude.com.evil.tld/x', null).url).toBeNull()
  })
})

describe('stripAnsi', () => {
  it('removes CSI and OSC sequences', () => {
    expect(stripAnsi('\x1b[1mA\x1b[0m\x1b]0;title\x07B')).toBe('AB')
  })
})
