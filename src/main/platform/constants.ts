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
