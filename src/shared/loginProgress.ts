export type LoginStage = 'starting' | 'browser' | 'waiting' | 'success' | 'failed'

export interface LoginProgress {
  stage: LoginStage
  /** The sign-in URL printed by `claude auth login`, if seen yet. */
  url: string | null
}

// CSI, OSC and two-character escape sequences.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const LOGIN_URL = /https:\/\/(?:[\w-]+\.)*(?:claude\.com|claude\.ai|anthropic\.com)\/[^\s"'<>]+/

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** Derives the sign-in stage from the raw output of `claude auth login`. */
export function parseLoginOutput(raw: string, exitCode: number | null): LoginProgress {
  const text = stripAnsi(raw)
  const url = text.match(LOGIN_URL)?.[0] ?? null
  if (/login successful/i.test(text) || exitCode === 0) return { stage: 'success', url }
  if (exitCode !== null) return { stage: 'failed', url }
  if (url) return { stage: 'waiting', url }
  if (/browser/i.test(text)) return { stage: 'browser', url }
  return { stage: 'starting', url }
}
