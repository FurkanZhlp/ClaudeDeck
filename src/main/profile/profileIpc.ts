import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { shell } from 'electron'
import { DomainError } from '../../shared/errors'
import { IPC, optimizePtyId } from '../../shared/ipc'
import type { Account, GuidelinesUpdate, ProfileCategory, ProfileSource } from '../../shared/types'
import { markOnboardingComplete, type AccountService } from '../accounts/accountService'
import { buildSessionEnv, claudeCommand, defaultShell, resolveShellEnv } from '../env/shellEnv'
import { isSize, isText, type IpcTools } from '../ipcUtil'
import type { PtyManager } from '../pty/ptyManager'
import type { Repository } from '../state/repository'
import { ensureGuidelines } from './guidelines'
import { diffProfile, importProfile, isProfileCategory, summarizeSource } from './importer'

export const INITIAL_MESSAGE =
  'Please start the ClaudeDeck profile optimization described in your system prompt. ' +
  'Begin by reviewing this profile and explain your plan before changing anything.'

interface Deps {
  handle: IpcTools['handle']
  repo: Repository
  ptys: PtyManager
  accounts: AccountService
  send: (channel: string, ...args: unknown[]) => void
  globalDir: string
  guidelinesText: string
  optimizePrompt: string
  /** Guideline upgrades found before the renderer was ready; each is handed out once. */
  takePendingGuidelineUpdates: () => GuidelinesUpdate[]
}

/** Empty cwd for the optimize session; the profile itself is added with `--add-dir`. */
export const optimizeWorkspace = (configDir: string): string =>
  join(configDir, 'claudedeck', 'workspace')

/** Installs or upgrades guidelines for every account and reports the upgrades to the renderer. */
export function installGuidelinesForAccounts(
  accounts: Account[],
  guidelinesText: string,
  send: Deps['send']
): void {
  for (const account of accounts) {
    try {
      const result = ensureGuidelines(account.configDir, guidelinesText)
      if (result && result.from !== null) {
        const update: GuidelinesUpdate = { accountId: account.id, ...result }
        send(IPC.profileGuidelinesUpdated, update)
      }
    } catch (error) {
      console.warn('[profile] could not install guidelines', account.id, error)
    }
  }
}

function parseCategories(value: unknown): ProfileCategory[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isProfileCategory)) {
    throw new DomainError('INVALID')
  }
  return value
}

export function registerProfileIpc(deps: Deps): void {
  const { handle, repo, ptys, accounts, send } = deps

  const sourceDir = (source: ProfileSource): string => {
    if (source?.kind === 'global') return deps.globalDir
    if (source?.kind === 'account' && isText(source.accountId)) {
      return repo.account(source.accountId).configDir
    }
    throw new DomainError('INVALID')
  }

  /** Resolves both ends and rejects importing an account into itself. */
  const endpoints = (accountId: string, source: ProfileSource): [string, Account] => {
    if (!isText(accountId)) throw new DomainError('INVALID')
    const account = repo.account(accountId)
    if (source?.kind === 'account' && source.accountId === accountId) {
      throw new DomainError('INVALID')
    }
    return [sourceDir(source), account]
  }

  handle(IPC.profileSummarize, (source: ProfileSource) => summarizeSource(sourceDir(source)))

  handle(IPC.profileDiff, (accountId: string, source: ProfileSource) => {
    const [from, account] = endpoints(accountId, source)
    return diffProfile(from, account.configDir)
  })

  handle(
    IPC.profileImport,
    async (accountId: string, source: ProfileSource, categories: ProfileCategory[]) => {
      const [from, account] = endpoints(accountId, source)
      const chosen = parseCategories(categories)
      // A running Claude reads plugins and settings from the profile being replaced.
      if (ptys.hasAccount(account.id)) throw new DomainError('ACCOUNT_RUNNING')
      accounts.ensureConfigDir(account)
      // A ProfileImportError names the failed category; the IPC layer logs it.
      const result = await importProfile(from, account.configDir, chosen)
      console.info('[profile] imported', account.id, source.kind, result.imported.join(','))
      return result
    }
  )

  handle(IPC.profileTakeGuidelineUpdates, () => deps.takePendingGuidelineUpdates())

  handle(IPC.profileStartOptimize, async (accountId: string, cols: number, rows: number) => {
    if (!isText(accountId) || !isSize(cols) || !isSize(rows)) throw new DomainError('INVALID')
    const id = optimizePtyId(accountId)
    const ticket = ptys.ticket(id)
    repo.account(accountId)
    if (!(await accounts.claudeAvailable())) throw new DomainError('CLAUDE_NOT_FOUND')
    const base = await resolveShellEnv()
    const account = repo.account(accountId)
    accounts.ensureConfigDir(account)
    try {
      markOnboardingComplete(account.configDir)
    } catch (error) {
      console.warn('[profile] could not mark onboarding complete', error)
    }
    installGuidelinesForAccounts([account], deps.guidelinesText, send)
    const workspace = optimizeWorkspace(account.configDir)
    mkdirSync(workspace, { recursive: true })
    ptys.spawn(
      id,
      {
        file: defaultShell(base),
        args: [
          '-ilc',
          claudeCommand(account.configDir, [
            '--add-dir',
            account.configDir,
            '--append-system-prompt',
            deps.optimizePrompt,
            INITIAL_MESSAGE
          ])
        ],
        cwd: workspace,
        env: buildSessionEnv(base, account),
        cols,
        rows,
        accountId: account.id
      },
      ticket
    )
    return null
  })

  handle(IPC.profileOpenFolder, async (accountId: string) => {
    if (!isText(accountId)) throw new DomainError('INVALID')
    const account = repo.account(accountId)
    accounts.ensureConfigDir(account)
    const error = await shell.openPath(account.configDir)
    if (error) throw new DomainError('PATH_MISSING')
    return null
  })
}
