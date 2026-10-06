import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import type { Account } from '../../shared/types'

type Env = Record<string, string>

const MARKER = '__CLAUDEDECK_ENV__'
// Uygulama bir Claude Code oturumundan başlatılmışsa bu değişkenler alt süreçlere sızmasın.
const STRIPPED = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CONFIG_DIR',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE'
])

export function parseEnvOutput(out: string): Env {
  const start = out.lastIndexOf(MARKER)
  if (start < 0) return {}
  const env: Env = {}
  for (const entry of out.slice(start + MARKER.length).split('\0')) {
    const eq = entry.indexOf('=')
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return env
}

export function sanitizeEnv(env: Record<string, string | undefined>): Env {
  const out: Env = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !STRIPPED.has(key)) out[key] = value
  }
  return out
}

export function withFallbackPath(env: Env, home: string): Env {
  const parts = (env.PATH ?? '').split(':').filter(Boolean)
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', `${home}/.local/bin`]) {
    if (!parts.includes(dir)) parts.push(dir)
  }
  return { ...env, PATH: parts.join(':') }
}

export function buildSessionEnv(base: Env, account: Pick<Account, 'configDir'>): Env {
  return {
    ...base,
    CLAUDE_CONFIG_DIR: account.configDir,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'ClaudeDeck',
    LANG: base.LANG || 'en_US.UTF-8'
  }
}

export function defaultShell(env: Env): string {
  return env.SHELL || '/bin/zsh'
}

let cached: Promise<Env> | null = null

/** Finder'dan açılan uygulamada PATH eksik olur; kullanıcının login shell env'i bir kez okunur. */
export function resolveShellEnv(): Promise<Env> {
  cached ??= new Promise((resolve) => {
    const current = sanitizeEnv(process.env)
    execFile(
      defaultShell(current),
      ['-ilc', `printf '${MARKER}'; env -0`],
      { timeout: 10_000, maxBuffer: 10 * 1024 * 1024, env: current },
      (_error, stdout) => {
        const parsed = parseEnvOutput(String(stdout ?? ''))
        const base = Object.keys(parsed).length > 0 ? sanitizeEnv(parsed) : current
        resolve(withFallbackPath(base, homedir()))
      }
    )
  })
  return cached
}
