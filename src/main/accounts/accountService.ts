import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DomainError } from '../../shared/errors'
import type { Account, AccountStatus } from '../../shared/types'
import { buildSessionEnv } from '../env/shellEnv'

type Env = Record<string, string>

export function parseAuthStatus(stdout: string): AccountStatus {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end < start) return { loggedIn: false }
  try {
    const json = JSON.parse(stdout.slice(start, end + 1)) as { loggedIn?: unknown; email?: unknown }
    const status: AccountStatus = { loggedIn: json.loggedIn === true }
    if (typeof json.email === 'string') status.email = json.email
    return status
  } catch {
    return { loggedIn: false }
  }
}

/**
 * `claude auth login` stores credentials but leaves first-run onboarding pending, so an
 * interactive session would walk through onboarding and ask for a login method again.
 * Marks onboarding complete for signed-in config dirs only; other keys are preserved.
 * Returns true when the file was changed.
 */
export function markOnboardingComplete(configDir: string): boolean {
  const file = join(configDir, '.claude.json')
  if (!existsSync(file)) return false
  const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  if (!json.oauthAccount || json.hasCompletedOnboarding === true) return false
  json.hasCompletedOnboarding = true
  const tmp = `${file}.claudedeck-tmp`
  writeFileSync(tmp, JSON.stringify(json, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
  return true
}

/** Claude Code keeps transcripts in `projects/<cwd with non-alphanumerics as dashes>/`. */
export function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
}

/** A session id only has a conversation to resume once a message was sent in it. */
export function hasConversation(configDir: string, cwd: string, sessionId: string): boolean {
  return existsSync(transcriptPath(configDir, cwd, sessionId))
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Silinecek klasör saklanan yoldan değil, hesap kimliğinden türetilir. */
export function accountDir(root: string, id: string): string {
  if (!UUID.test(id)) throw new DomainError('INVALID')
  return join(root, id)
}

function run(args: string[], env: Env): Promise<string> {
  return new Promise((done) => {
    // claude giriş yoksa sıfırdan farklı kodla çıkabilir; stdout yine de değerlendirilir.
    execFile('claude', args, { env, timeout: 15_000 }, (_error, stdout) =>
      done(String(stdout ?? ''))
    )
  })
}

export class AccountService {
  constructor(
    private readonly accountsRoot: string,
    private readonly baseEnv: () => Promise<Env>
  ) {}

  ensureConfigDir(account: Account): void {
    mkdirSync(account.configDir, { recursive: true, mode: 0o700 })
  }

  async status(account: Account): Promise<AccountStatus> {
    const env = buildSessionEnv(await this.baseEnv(), account)
    return parseAuthStatus(await run(['auth', 'status'], env))
  }

  /** Keychain'deki oturumu temizler, sonra config klasörünü siler. */
  async destroy(account: Account): Promise<void> {
    const configDir = accountDir(this.accountsRoot, account.id)
    await run(['auth', 'logout'], buildSessionEnv(await this.baseEnv(), { configDir }))
    rmSync(configDir, { recursive: true, force: true })
  }

  async claudeAvailable(): Promise<boolean> {
    const env = await this.baseEnv()
    return new Promise((done) =>
      execFile('/usr/bin/which', ['claude'], { env }, (error) => done(!error))
    )
  }
}
