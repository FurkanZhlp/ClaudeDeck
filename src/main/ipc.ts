import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { DomainError } from '../shared/errors'
import { IPC, loginPtyId } from '../shared/ipc'
import type {
  Account,
  AccountInput,
  Language,
  ProjectInput,
  SessionKind,
  UpdateInfo,
  UsageSettings
} from '../shared/types'
import {
  hasConversation,
  markOnboardingComplete,
  type AccountService
} from './accounts/accountService'
import type { PtyManager } from './pty/ptyManager'
import { isSize, isText, type IpcTools } from './ipcUtil'
import { MCP_TOKEN_ENV } from './mcp/sessionTokens'
import { platform } from './platform'
import type { Repository } from './state/repository'

interface Deps {
  repo: Repository
  accounts: AccountService
  ptys: PtyManager
  getWindow: () => BrowserWindow | null
  /** Handler registration and sender checks shared by every IPC module. */
  ipcTools: IpcTools
  onLanguageChange: () => void
  checkUpdate: () => Promise<UpdateInfo | null>
  openUpdate: () => Promise<void>
  /** Account-level setup (guidelines, MCP registration) before Claude runs for an account. */
  prepareAccount: (account: Account) => void
  /** A project's account or folder changed; its notes must follow. */
  onProjectMoved: (
    before: { configDir: string; path: string },
    after: { configDir: string; path: string },
    projectId: string
  ) => void
  /** Pulls notes left under other accounts into the project's current memory folder. */
  prepareProjectMemory: (projectId: string) => void
  /** Token that limits a Claude tab's ClaudeDeck MCP access to its own project. */
  issueMcpToken: (scope: { sessionId: string; projectId: string; accountId: string }) => string
  revokeMcpTokens: (sessionIds: string[]) => void
  /** Stops a running profile optimization before its account goes away. */
  cancelOptimize: (accountId: string) => void
  /** Usage display or menu bar settings changed. */
  onUsageSettingsChange: () => void
  /** An account was created, renamed or removed (menu bar title and tooltip follow). */
  onAccountsChange: () => void
  /**
   * Closes a removed account's usage watcher and drops its usage. Runs before its folder is
   * deleted: an open watch handle blocks rm on Windows.
   */
  forgetUsage: (accountId: string) => void
  /** Applies the login item setting to macOS (packaged app only). */
  applyLaunchAtLogin: (enabled: boolean) => void
}

function completeOnboarding(configDir: string): void {
  try {
    markOnboardingComplete(configDir)
  } catch (error) {
    console.warn('[ipc] could not mark onboarding complete', error)
  }
}

export function registerIpc({
  repo,
  accounts,
  ptys,
  getWindow,
  ipcTools,
  onLanguageChange,
  checkUpdate,
  openUpdate,
  prepareAccount,
  onProjectMoved,
  prepareProjectMemory,
  issueMcpToken,
  revokeMcpTokens,
  cancelOptimize,
  onUsageSettingsChange,
  onAccountsChange,
  forgetUsage,
  applyLaunchAtLogin
}: Deps): void {
  const { handle, trusted } = ipcTools

  handle(IPC.stateGet, () => repo.get())

  handle(IPC.accountCreate, (input: AccountInput) => {
    const result = repo.createAccount({ name: input?.name, color: input?.color })
    accounts.ensureConfigDir(result.account)
    prepareAccount(result.account)
    onAccountsChange()
    return result
  })
  handle(IPC.accountUpdate, (id: string, patch: Partial<AccountInput>) => {
    const state = repo.updateAccount(id, { name: patch?.name, color: patch?.color })
    onAccountsChange()
    return state
  })
  handle(IPC.accountRemove, async (id: string, deleteFiles: boolean) => {
    const account = repo.account(id)
    ptys.kill(loginPtyId(id))
    // Proje başka hesaba geçmiş ama eski hesapla çalışan oturum olabilir.
    if (ptys.hasAccount(id)) throw new DomainError('ACCOUNT_RUNNING')
    cancelOptimize(id)
    const state = repo.removeAccount(id)
    forgetUsage(id)
    onAccountsChange()
    if (deleteFiles === true) {
      try {
        await accounts.destroy(account)
      } catch (error) {
        console.error('[ipc] hesap dosyaları silinemedi', error)
      }
    }
    return state
  })
  handle(IPC.accountStatus, async (id: string) => {
    const account = repo.account(id)
    const status = await accounts.status(account)
    if (status.loggedIn) completeOnboarding(account.configDir)
    const email = status.loggedIn ? status.email : undefined
    const state = email !== account.email ? repo.updateAccount(id, { email }) : repo.get()
    return { status, state }
  })

  handle(IPC.projectCreate, (input: ProjectInput) =>
    repo.createProject({ name: input?.name, path: input?.path, accountId: input?.accountId })
  )
  handle(IPC.projectUpdate, (id: string, patch: Partial<ProjectInput>) => {
    const location = (projectId: string): { configDir: string; path: string } => {
      const project = repo.project(projectId)
      return { configDir: repo.account(project.accountId).configDir, path: project.path }
    }
    const before = location(id)
    const state = repo.updateProject(id, {
      name: patch?.name,
      path: patch?.path,
      accountId: patch?.accountId
    })
    const after = location(id)
    if (before.configDir !== after.configDir || before.path !== after.path) {
      onProjectMoved(before, after, id)
      // Running tabs keep the old account; their MCP scope no longer matches the project.
      revokeMcpTokens(state.sessions.filter((s) => s.projectId === id).map((s) => s.id))
    }
    return state
  })
  handle(IPC.projectRemove, (id: string) => {
    const { state, removedSessionIds } = repo.removeProject(id)
    removedSessionIds.forEach((sessionId) => ptys.kill(sessionId))
    revokeMcpTokens(removedSessionIds)
    return state
  })

  handle(IPC.sessionCreate, (projectId: string, kind: SessionKind, title: string) =>
    repo.createSession(projectId, kind, title)
  )
  handle(IPC.sessionRename, (id: string, title: string) => repo.renameSession(id, title))
  handle(IPC.sessionRemove, (id: string) => {
    ptys.kill(id)
    revokeMcpTokens([id])
    return repo.removeSession(id)
  })

  handle(IPC.settingsSetLanguage, (language: Language | null) => {
    const state = repo.setLanguage(language)
    onLanguageChange()
    return state
  })

  handle(IPC.settingsSetUsage, (patch: Partial<UsageSettings>) => {
    if (!patch || typeof patch !== 'object') throw new DomainError('INVALID')
    const state = repo.setUsageSettings({
      display: patch.display,
      trayEnabled: patch.trayEnabled,
      trayMetric: patch.trayMetric,
      trayAccount: patch.trayAccount
    })
    onUsageSettingsChange()
    return state
  })

  handle(IPC.settingsSetLaunchAtLogin, (enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new DomainError('INVALID')
    const state = repo.setLaunchAtLogin(enabled)
    applyLaunchAtLogin(enabled)
    return state
  })

  handle(
    IPC.ptyStartSession,
    async (sessionId: string, resume: boolean, cols: number, rows: number) => {
      if (!isSize(cols) || !isSize(rows)) throw new DomainError('INVALID')
      const ticket = ptys.ticket(sessionId)
      const kind = repo.session(sessionId).kind
      if (kind === 'claude' && !(await accounts.claudeAvailable())) {
        throw new DomainError('CLAUDE_NOT_FOUND')
      }
      const base = await platform.resolveBaseEnv()

      // Beklerken oturum, proje ya da hesap değişmiş olabilir; güncel kayıtları oku.
      const session = repo.session(sessionId)
      const project = repo.project(session.projectId)
      const account = repo.account(project.accountId)
      if (!existsSync(project.path)) throw new DomainError('PATH_MISSING')
      accounts.ensureConfigDir(account)
      let mcpToken: string | null = null
      if (session.kind === 'claude') {
        completeOnboarding(account.configDir)
        prepareAccount(account)
        prepareProjectMemory(project.id)
        mcpToken = issueMcpToken({
          sessionId: session.id,
          projectId: project.id,
          accountId: account.id
        })
      }

      let started = false
      try {
        let launch = platform.shellLaunch(account.configDir, base)
        if (session.kind === 'claude') {
          let claudeArgs: string[]
          const stored = session.claudeSessionId
          if (
            resume === true &&
            stored &&
            hasConversation(account.configDir, project.path, stored)
          ) {
            claudeArgs = ['--resume', stored]
          } else if (resume === true && stored) {
            // Nothing was ever sent in this tab, so there is no transcript; start it under the same id.
            claudeArgs = ['--session-id', stored]
          } else {
            const claudeSessionId = randomUUID()
            repo.setClaudeSessionId(session.id, claudeSessionId)
            claudeArgs = ['--session-id', claudeSessionId]
          }
          launch = platform.claudeLaunch(account.configDir, claudeArgs, base)
        }
        started = ptys.spawn(
          sessionId,
          {
            file: launch.file,
            args: launch.args,
            cwd: project.path,
            env: mcpToken ? { ...launch.env, [MCP_TOKEN_ENV]: mcpToken } : launch.env,
            cols,
            rows,
            accountId: account.id
          },
          ticket
        )
      } finally {
        // The tab never started (launch error, or closed while starting): its MCP token must not
        // outlive it. A token is per tab, so this only drops the one issued above.
        if (!started && mcpToken) revokeMcpTokens([session.id])
      }
      return { accountId: account.id }
    }
  )

  handle(IPC.ptyStartLogin, async (accountId: string, cols: number, rows: number) => {
    if (!isSize(cols) || !isSize(rows)) throw new DomainError('INVALID')
    const id = loginPtyId(accountId)
    const ticket = ptys.ticket(id)
    repo.account(accountId)
    if (!(await accounts.claudeAvailable())) throw new DomainError('CLAUDE_NOT_FOUND')
    const base = await platform.resolveBaseEnv()
    const account = repo.account(accountId)
    accounts.ensureConfigDir(account)
    const launch = platform.claudeLaunch(account.configDir, ['auth', 'login'], base)
    ptys.spawn(
      id,
      {
        file: launch.file,
        args: launch.args,
        cwd: homedir(),
        env: launch.env,
        cols,
        rows,
        accountId: account.id
      },
      ticket
    )
    return null
  })

  ipcMain.on(IPC.ptyWrite, (event, id: unknown, data: unknown) => {
    if (trusted(event) && isText(id) && isText(data)) ptys.write(id, data)
  })
  ipcMain.on(IPC.ptyResize, (event, id: unknown, cols: unknown, rows: unknown) => {
    if (trusted(event) && isText(id) && isSize(cols) && isSize(rows)) ptys.resize(id, cols, rows)
  })
  handle(IPC.ptyKill, (id: string) => {
    if (isText(id)) ptys.kill(id)
    if (isText(id)) revokeMcpTokens([id])
    return null
  })

  handle(IPC.systemPickFolder, async () => {
    const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const win = getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle(IPC.systemPathExists, (path: string) => isText(path) && existsSync(path))
  handle(IPC.systemClaudeAvailable, () => accounts.claudeAvailable())
  handle(IPC.updateCheck, () => checkUpdate())
  handle(IPC.updateOpen, async () => {
    await openUpdate()
    return null
  })
}
