import { describe, expect, it } from 'vitest'
import {
  chainInvocation,
  findGitBash,
  GIT_BASH_CANDIDATES,
  OURS,
  psQuote,
  windowsArg,
  windowsPowerShellPath,
  windowsStatuslineCommand,
  windowsStatuslineScript
} from './statuslineScript'

const PS = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const POWERSHELL = { kind: 'powershell', path: PS } as const

const DIR = "C:\\Users\\Ayşe O'Neil\\AppData\\Roaming\\ClaudeDeck\\accounts\\a1\\claudedeck"

describe('windowsStatuslineScript', () => {
  it('renders the recorder without an original statusline', () => {
    expect(windowsStatuslineScript(DIR, null, POWERSHELL)).toMatchSnapshot()
  })

  it('chains the original through Git Bash', () => {
    const shell = { kind: 'bash', path: 'C:\\Program Files\\Git\\bin\\bash.exe' } as const
    expect(windowsStatuslineScript(DIR, 'jq -r ".model" | tr a b', shell)).toMatchSnapshot()
  })

  it('chains the original through PowerShell', () => {
    expect(windowsStatuslineScript(DIR, "Write-Host 'mine'", POWERSHELL)).toMatchSnapshot()
  })

  it('doubles typographic single quotes in the chained command', () => {
    const script = windowsStatuslineScript(DIR, 'echo \u2018hi\u2019 \u201Cx\u201D', {
      kind: 'bash',
      path: 'C:\\Git\\bin\\bash.exe'
    })
    expect(script).toContain(
      `$psi.Arguments = '-c "echo \u2018\u2018hi\u2019\u2019 \u201Cx\u201D"'`
    )
  })

  it('starts with a UTF-8 BOM so Windows PowerShell reads non-ASCII paths', () => {
    expect(windowsStatuslineScript(DIR, null, POWERSHELL).charCodeAt(0)).toBe(0xfeff)
  })
})

describe('psQuote', () => {
  it('doubles every character PowerShell reads as a single quote', () => {
    expect(psQuote("a'b")).toBe("'a''b'")
    expect(psQuote('\u2018\u2019\u201A\u201B')).toBe(
      "'\u2018\u2018\u2019\u2019\u201A\u201A\u201B\u201B'"
    )
    expect(psQuote('say \u201Chi\u201D $x')).toBe("'say \u201Chi\u201D $x'")
  })
})

describe('windowsPowerShellPath', () => {
  it('builds the absolute path from SystemRoot in any case, with forward slashes', () => {
    expect(windowsPowerShellPath({ SystemRoot: 'C:\\WINDOWS' })).toBe(
      'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe'
    )
    expect(windowsPowerShellPath({ SYSTEMROOT: 'D:\\Win\\' })).toBe(
      'D:/Win/System32/WindowsPowerShell/v1.0/powershell.exe'
    )
  })

  it('falls back to C:/Windows when SystemRoot is missing or needs quoting', () => {
    for (const env of [{}, { SystemRoot: 'C:\\My Win' }, { SystemRoot: 'relative' }]) {
      expect(windowsPowerShellPath(env)).toBe(PS)
    }
  })
})

describe('windowsStatuslineCommand', () => {
  const FLAGS = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File'

  it('uses the absolute PowerShell path, forward slashes and single quotes', () => {
    expect(
      windowsStatuslineCommand('C:\\Users\\Ayse Kaya\\AppData\\claudedeck\\statusline.ps1', PS)
    ).toBe(`${PS} ${FLAGS} 'C:/Users/Ayse Kaya/AppData/claudedeck/statusline.ps1'`)
  })

  it('falls back to double quotes for a user name with an apostrophe', () => {
    expect(
      windowsStatuslineCommand("C:\\Users\\Ayşe O'Neil\\AppData\\claudedeck\\statusline.ps1", PS)
    ).toBe(`${PS} ${FLAGS} "C:/Users/Ayşe O'Neil/AppData/claudedeck/statusline.ps1"`)
  })

  it('treats typographic single quotes like an apostrophe', () => {
    expect(windowsStatuslineCommand('C:\\Users\\O\u2019Neil\\statusline.ps1', PS)).toBe(
      `${PS} ${FLAGS} "C:/Users/O\u2019Neil/statusline.ps1"`
    )
  })

  it('refuses a path no quoting can carry through both shells', () => {
    for (const path of [
      "C:\\Users\\O'$x\\statusline.ps1",
      "C:\\Users\\O'`x\\statusline.ps1",
      'C:\\Users\\O\u2019\u201Cx\u201D\\statusline.ps1',
      'C:\\Users\\O\u2018\u201Ex\\statusline.ps1'
    ]) {
      expect(windowsStatuslineCommand(path, PS)).toBeNull()
    }
  })

  it('is recognised as ours on every platform', () => {
    for (const command of [
      windowsStatuslineCommand('C:\\a\\claudedeck\\statusline.ps1', PS) ?? '',
      "'/Users/a/claudedeck/statusline.sh'",
      'C:\\a\\claudedeck\\statusline.ps1'
    ]) {
      expect(OURS.test(command)).toBe(true)
    }
    expect(OURS.test('~/.claude/statusline.sh')).toBe(false)
  })
})

describe('windowsArg', () => {
  it('quotes per CommandLineToArgvW rules', () => {
    expect(windowsArg('plain')).toBe('plain')
    expect(windowsArg('')).toBe('""')
    expect(windowsArg('a b')).toBe('"a b"')
    expect(windowsArg('say "hi"')).toBe('"say \\"hi\\""')
    expect(windowsArg('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"')
    expect(windowsArg('a\\"b c')).toBe('"a\\\\\\"b c"')
  })
})

describe('chainInvocation', () => {
  it('runs bash -c with one quoted argument', () => {
    expect(chainInvocation('echo "x y"', { kind: 'bash', path: 'C:\\Git\\bin\\bash.exe' })).toEqual(
      { file: 'C:\\Git\\bin\\bash.exe', args: '-c "echo \\"x y\\""' }
    )
  })

  it('encodes the command for PowerShell', () => {
    const { file, args } = chainInvocation("Write-Host 'ş'", POWERSHELL)
    expect(file).toBe(PS)
    const encoded = args.split(' ').at(-1) ?? ''
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe("Write-Host 'ş'")
  })
})

describe('findGitBash', () => {
  it('prefers CLAUDE_CODE_GIT_BASH_PATH, then the default locations', () => {
    const custom = 'D:\\Tools\\Git\\bin\\bash.exe'
    const all = new Set([custom, ...GIT_BASH_CANDIDATES])
    expect(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: custom }, (p) => all.has(p))).toBe(custom)
    expect(findGitBash({}, (p) => all.has(p))).toBe(GIT_BASH_CANDIDATES[0])
    expect(findGitBash({}, (p) => p === GIT_BASH_CANDIDATES[1])).toBe(GIT_BASH_CANDIDATES[1])
    expect(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: custom }, () => false)).toBeNull()
  })
})
