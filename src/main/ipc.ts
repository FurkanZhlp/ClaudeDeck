import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron'
import { DomainError } from '../shared/errors'
import { IPC, loginPtyId, type IpcResult } from '../shared/ipc'
import type { AccountInput, Language, ProjectInput, SessionKind, UpdateInfo } from '../shared/types'
import {
  hasConversation,
  markOnboardingComplete,
  type AccountService
} from './accounts/accountService'
import { buildSessionEnv, claudeCommand, defaultShell, resolveShellEnv } from './env/shellEnv'
import type { PtyManager } from './pty/ptyManager'
import type { Repository } from './state/repository'

interface Deps {
  repo: Repository
  accounts: AccountService
  ptys: PtyManager
  getWindow: () => BrowserWindow | null
  onLanguageChange: () => void
  checkUpdate: () => Promise<UpdateInfo | null>
  openUpdate: () => Promise<void>
}

function completeOnboarding(configDir: string): void {
  try {
    markOnboardingComplete(configDir)
  } catch (error) {
    console.warn('[ipc] could not mark onboarding complete', error)
  }
}

const isText = (v: unknown): v is string => typeof v === 'string'
const isSize = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0

export function registerIpc({
  repo,
  accounts,
  ptys,
  getWindow,
  onLanguageChange,
  checkUpdate,
  openUpdate
}: Deps): void {
  // Yalnızca uygulamanın kendi penceresinden gelen mesajlar kabul edilir.
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    event.sender === getWindow()?.webContents

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
    ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
      if (!trusted(event)) return { ok: false, code: 'UNKNOWN' }
      try {
        return { ok: true, data: await fn(...args) }
      } catch (error) {
        if (error instanceof DomainError) return { ok: false, code: error.code }
        console.error(`[ipc] ${channel}`, error)
        return { ok: false, code: 'UNKNOWN' }
      }
    })
  }

  handle(IPC.stateGet, () => repo.get())

  handle(IPC.accountCreate, (input: AccountInput) => {
    const result = repo.createAccount({ name: input?.name, color: input?.color })
    accounts.ensureConfigDir(result.account)
    return result
  })
  handle(IPC.accountUpdate, (id: string, patch: Partial<AccountInput>) =>
    repo.updateAccount(id, { name: patch?.name, color: patch?.color })
  )
  handle(IPC.accountRemove, async (id: string, deleteFiles: boolean) => {
    const account = repo.account(id)
    ptys.kill(loginPtyId(id))
    // Proje başka hesaba geçmiş ama eski hesapla çalışan oturum olabilir.
    if (ptys.hasAccount(id)) throw new DomainError('ACCOUNT_RUNNING')
    const state = repo.removeAccount(id)
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
  handle(IPC.projectUpdate, (id: string, patch: Partial<ProjectInput>) =>
    repo.updateProject(id, { name: patch?.name, path: patch?.path, accountId: patch?.accountId })
  )
  handle(IPC.projectRemove, (id: string) => {
    const { state, removedSessionIds } = repo.removeProject(id)
    removedSessionIds.forEach((sessionId) => ptys.kill(sessionId))
    return state
  })

  handle(IPC.sessionCreate, (projectId: string, kind: SessionKind, title: string) =>
    repo.createSession(projectId, kind, title)
  )
  handle(IPC.sessionRename, (id: string, title: string) => repo.renameSession(id, title))
  handle(IPC.sessionRemove, (id: string) => {
    ptys.kill(id)
    return repo.removeSession(id)
  })

  handle(IPC.settingsSetLanguage, (language: Language | null) => {
    const state = repo.setLanguage(language)
    onLanguageChange()
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
      const base = await resolveShellEnv()

      // Beklerken oturum, proje ya da hesap değişmiş olabilir; güncel kayıtları oku.
      const session = repo.session(sessionId)
      const project = repo.project(session.projectId)
      const account = repo.account(project.accountId)
      if (!existsSync(project.path)) throw new DomainError('PATH_MISSING')
      accounts.ensureConfigDir(account)
      if (session.kind === 'claude') completeOnboarding(account.configDir)

      let args = ['-il']
      if (session.kind === 'claude') {
        let claudeArgs: string[]
        const stored = session.claudeSessionId
        if (resume === true && stored && hasConversation(account.configDir, project.path, stored)) {
          claudeArgs = ['--resume', stored]
        } else if (resume === true && stored) {
          // Nothing was ever sent in this tab, so there is no transcript; start it under the same id.
          claudeArgs = ['--session-id', stored]
        } else {
          const claudeSessionId = randomUUID()
          repo.setClaudeSessionId(session.id, claudeSessionId)
          claudeArgs = ['--session-id', claudeSessionId]
        }
        args = ['-ilc', claudeCommand(account.configDir, claudeArgs)]
      }
      ptys.spawn(
        sessionId,
        {
          file: defaultShell(base),
          args,
          cwd: project.path,
          env: buildSessionEnv(base, account),
          cols,
          rows,
          accountId: account.id
        },
        ticket
      )
      return { accountId: account.id }
    }
  )

  handle(IPC.ptyStartLogin, async (accountId: string, cols: number, rows: number) => {
    if (!isSize(cols) || !isSize(rows)) throw new DomainError('INVALID')
    const id = loginPtyId(accountId)
    const ticket = ptys.ticket(id)
    repo.account(accountId)
    if (!(await accounts.claudeAvailable())) throw new DomainError('CLAUDE_NOT_FOUND')
    const base = await resolveShellEnv()
    const account = repo.account(accountId)
    accounts.ensureConfigDir(account)
    ptys.spawn(
      id,
      {
        file: defaultShell(base),
        args: ['-ilc', claudeCommand(account.configDir, ['auth', 'login'])],
        cwd: homedir(),
        env: buildSessionEnv(base, account),
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
