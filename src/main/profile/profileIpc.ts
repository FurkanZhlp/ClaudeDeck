import { shell } from 'electron'
import { DomainError } from '../../shared/errors'
import { IPC } from '../../shared/ipc'
import type { Account, GuidelinesUpdate, ProfileCategory, ProfileSource } from '../../shared/types'
import type { AccountService } from '../accounts/accountService'
import { isText, type IpcTools } from '../ipcUtil'
import type { PtyManager } from '../pty/ptyManager'
import type { Repository } from '../state/repository'
import { diffProfile, importProfile, isProfileCategory, summarizeSource } from './importer'

interface Deps {
  handle: IpcTools['handle']
  repo: Repository
  ptys: PtyManager
  accounts: AccountService
  globalDir: string
  /** True while an optimize run edits the account's profile. */
  isOptimizing?: (accountId: string) => boolean
  /** Guideline upgrades found before the renderer was ready; each is handed out once. */
  takePendingGuidelineUpdates: () => GuidelinesUpdate[]
}

function parseCategories(value: unknown): ProfileCategory[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isProfileCategory)) {
    throw new DomainError('INVALID')
  }
  return value
}

export function registerProfileIpc(deps: Deps): void {
  const { handle, repo, ptys, accounts } = deps

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
      if (ptys.hasAccount(account.id) || deps.isOptimizing?.(account.id)) {
        throw new DomainError('ACCOUNT_RUNNING')
      }
      accounts.ensureConfigDir(account)
      // A ProfileImportError names the failed category; the IPC layer logs it.
      const result = await importProfile(from, account.configDir, chosen)
      console.info('[profile] imported', account.id, source.kind, result.imported.join(','))
      return result
    }
  )

  handle(IPC.profileTakeGuidelineUpdates, () => deps.takePendingGuidelineUpdates())

  handle(IPC.profileOpenFolder, async (accountId: string) => {
    if (!isText(accountId)) throw new DomainError('INVALID')
    const account = repo.account(accountId)
    accounts.ensureConfigDir(account)
    const error = await shell.openPath(account.configDir)
    if (error) throw new DomainError('PATH_MISSING')
    return null
  })
}
