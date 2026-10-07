/** Executable name of Claude Code, looked up on PATH. */
export const CLAUDE_BIN = 'claude'

/** Used by the POSIX locator; absolute so a broken PATH cannot hide it. */
export const WHICH_PATH = '/usr/bin/which'

/** Login + interactive shell: rc files run, so PATH matches the user's terminal. */
export const LOGIN_SHELL_ARGS = ['-il']
/** Same, running one command string. */
export const LOGIN_SHELL_COMMAND_FLAG = '-ilc'

/** `cp -c` of a large profile can take a while on slow disks. */
export const COPY_TIMEOUT_MS = 5 * 60 * 1000

export const NOT_IMPLEMENTED = 'not implemented'

/** Windows: only these PATHEXT entries can be started without a shell. */
export const WIN_DIRECT_EXTS = ['.exe', '.com']
/** Windows: npm shims, parsed for their target since `.cmd` needs `cmd.exe`. */
export const WIN_SHIM_EXTS = ['.cmd', '.bat']
/** Used when PATHEXT is missing; the Windows default order. */
export const WIN_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'
export const WIN_DEFAULT_SYSTEM_ROOT = 'C:\\Windows'
/** Native binary the npm package installs as its bin (`bin/claude.exe`). */
export const WIN_NPM_CLAUDE_EXE = [
  'node_modules',
  '@anthropic-ai',
  'claude-code',
  'bin',
  'claude.exe'
]

/** PowerShell 7, looked up on PATH. */
export const WIN_PWSH = 'pwsh.exe'
/** Windows PowerShell 5.1, relative to %SystemRoot%. */
export const WIN_POWERSHELL = ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe']
/** cmd.exe relative to %SystemRoot%, when %ComSpec% is unset. */
export const WIN_CMD = ['System32', 'cmd.exe']
export const POWERSHELL_ARGS = ['-NoLogo']
/** taskkill.exe relative to %SystemRoot%; absolute so PATH cannot shadow it. */
export const WIN_TASKKILL = ['System32', 'taskkill.exe']
