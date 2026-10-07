import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { win32 } from 'node:path'
import type { Account } from '../../shared/types'
import { samePath } from '../platform/paths'
import type { OsName } from '../platform/types'

type Env = Record<string, string>

const MARKER = '__CLAUDEDECK_ENV__'
// Uygulama bir Claude Code oturumundan başlatılmışsa bu değişkenler alt süreçlere sızmasın.
// Kimlik değişkenleri Keychain oturumunu ezer ve tüm hesapları aynı kimliğe bağlar.
// Anthropic profiles and Workload Identity Federation outrank a `/login` login as well.
export const CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_WORKSPACE_ID'
]
/**
 * ClaudeDeck accounts are subscription logins. These send requests (and so the account's token)
 * to another endpoint or provider, so they never reach a child process either.
 */
export const ENDPOINT_VARS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'AWS_BEARER_TOKEN_BEDROCK'
]
const STRIPPED = new Set([
  ...CREDENTIAL_VARS,
  ...ENDPOINT_VARS,
  'NODE_OPTIONS',
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

/** Windows spells the search path `Path`; env names are case-insensitive there. */
export const WIN_PATH_KEY = 'Path'

/** Reads a variable; on Windows the name matches in any case. */
export function getEnv(env: Env, name: string, os: OsName = 'darwin'): string | undefined {
  if (os !== 'win32') return env[name]
  const upper = name.toUpperCase()
  let found: string | undefined
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === upper) found = value
  return found
}

/** `Path` entries name the same folder (case, separators and a trailing slash ignored). */
const samePathEntry = (a: string, b: string): boolean => samePath(a, b, win32)

/**
 * Collapses names that differ only in case, as Windows does: the last value wins under the first
 * spelling. Every `PATH` spelling is merged into one `Path` with duplicate entries dropped.
 */
export function normalizeWindowsEnv(env: Record<string, string | undefined>): Env {
  const out: Env = {}
  const spelling = new Map<string, string>()
  const pathParts: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (upper === 'PATH') {
      for (const dir of value.split(';')) {
        if (dir && !pathParts.some((seen) => samePathEntry(seen, dir))) pathParts.push(dir)
      }
      continue
    }
    const name = spelling.get(upper) ?? key
    spelling.set(upper, name)
    out[name] = value
  }
  if (pathParts.length > 0) out[WIN_PATH_KEY] = pathParts.join(';')
  return out
}

/** Drops undefined values and the variables child processes must not inherit. */
export function sanitizeEnv(env: Record<string, string | undefined>, os: OsName = 'darwin'): Env {
  const source = os === 'win32' ? normalizeWindowsEnv(env) : env
  const out: Env = {}
  for (const [key, value] of Object.entries(source)) {
    const name = os === 'win32' ? key.toUpperCase() : key
    if (value !== undefined && !STRIPPED.has(name)) out[key] = value
  }
  return out
}

/** Install locations of Claude Code on Windows: native installer, npm global, WinGet. */
export function windowsFallbackDirs(env: Env, home: string): string[] {
  const appData = getEnv(env, 'APPDATA', 'win32') || win32.join(home, 'AppData', 'Roaming')
  const localAppData = getEnv(env, 'LOCALAPPDATA', 'win32') || win32.join(home, 'AppData', 'Local')
  return [
    win32.join(home, '.local', 'bin'),
    win32.join(appData, 'npm'),
    win32.join(localAppData, 'Microsoft', 'WinGet', 'Links')
  ]
}

/** Appends the usual install dirs that a GUI-started app may lack, without duplicates. */
export function withFallbackPath(env: Env, home: string, os: OsName = 'darwin'): Env {
  if (os === 'win32') {
    const normalized = normalizeWindowsEnv(env)
    const parts = (normalized[WIN_PATH_KEY] ?? '').split(';').filter(Boolean)
    for (const dir of windowsFallbackDirs(normalized, home)) {
      if (!parts.some((seen) => samePathEntry(seen, dir))) parts.push(dir)
    }
    return { ...normalized, [WIN_PATH_KEY]: parts.join(';') }
  }
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

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Login shell rc dosyaları env'i ezebilir; hesap değişkenleri komut satırında yeniden basılır. */
export function claudeCommand(configDir: string, args: string[]): string {
  return [
    'exec env',
    ...[...CREDENTIAL_VARS, ...ENDPOINT_VARS].map((name) => `-u ${name}`),
    `CLAUDE_CONFIG_DIR=${shellQuote(configDir)}`,
    'claude',
    ...args.map(shellQuote)
  ].join(' ')
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
