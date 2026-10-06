import { execFile } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
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

export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function run(args: string[], env: Env): Promise<string> {
  return new Promise((done) => {
    // claude giriş yoksa sıfırdan farklı kodla çıkabilir; stdout yine de değerlendirilir.
    execFile('claude', args, { env, timeout: 15_000 }, (_error, stdout) => done(String(stdout ?? '')))
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
    if (!isInside(this.accountsRoot, account.configDir)) throw new DomainError('UNKNOWN')
    await run(['auth', 'logout'], buildSessionEnv(await this.baseEnv(), account))
    rmSync(account.configDir, { recursive: true, force: true })
  }

  async claudeAvailable(): Promise<boolean> {
    const env = await this.baseEnv()
    return new Promise((done) =>
      execFile('/usr/bin/which', ['claude'], { env }, (error) => done(!error))
    )
  }
}
