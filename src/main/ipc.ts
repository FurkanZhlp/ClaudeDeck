import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { DomainError } from '../shared/errors'
import { IPC, loginPtyId, type IpcResult } from '../shared/ipc'
import type { AccountInput, Language, ProjectInput, SessionKind } from '../shared/types'
import type { AccountService } from './accounts/accountService'
import { buildSessionEnv, defaultShell, resolveShellEnv } from './env/shellEnv'
import type { PtyManager } from './pty/ptyManager'
import type { Repository } from './state/repository'

interface Deps {
  repo: Repository
  accounts: AccountService
  ptys: PtyManager
  getWindow: () => BrowserWindow | null
  onLanguageChange: () => void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<unknown>> => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (error) {
      if (error instanceof DomainError) return { ok: false, code: error.code }
      console.error(`[ipc] ${channel}`, error)
      return { ok: false, code: 'UNKNOWN' }
    }
  })
}

const isText = (v: unknown): v is string => typeof v === 'string'
const isSize = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0

export function registerIpc({ repo, accounts, ptys, getWindow, onLanguageChange }: Deps): void {
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
    const state = repo.removeAccount(id)
    ptys.kill(loginPtyId(id))
    if (deleteFiles === true) await accounts.destroy(account)
    return state
  })
  handle(IPC.accountStatus, async (id: string) => {
    const account = repo.account(id)
    const status = await accounts.status(account)
    const state =
      status.email && status.email !== account.email
        ? repo.updateAccount(id, { email: status.email })
        : repo.get()
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

  handle(IPC.ptyStartSession, async (sessionId: string, resume: boolean, cols: number, rows: number) => {
    if (!isSize(cols) || !isSize(rows)) throw new DomainError('INVALID')
    const session = repo.session(sessionId)
    const project = repo.project(session.projectId)
    const account = repo.account(project.accountId)
    if (!existsSync(project.path)) throw new DomainError('PATH_MISSING')
    if (session.kind === 'claude' && !(await accounts.claudeAvailable())) {
      throw new DomainError('CLAUDE_NOT_FOUND')
    }
    accounts.ensureConfigDir(account)
    const base = await resolveShellEnv()
    const command = resume === true ? 'claude --continue' : 'claude'
    ptys.spawn(sessionId, {
      file: defaultShell(base),
      args: session.kind === 'claude' ? ['-ilc', command] : ['-il'],
      cwd: project.path,
      env: buildSessionEnv(base, account),
      cols,
      rows
    })
    return { accountId: account.id }
  })

  handle(IPC.ptyStartLogin, async (accountId: string, cols: number, rows: number) => {
    if (!isSize(cols) || !isSize(rows)) throw new DomainError('INVALID')
    const account = repo.account(accountId)
    if (!(await accounts.claudeAvailable())) throw new DomainError('CLAUDE_NOT_FOUND')
    accounts.ensureConfigDir(account)
    const base = await resolveShellEnv()
    ptys.spawn(loginPtyId(accountId), {
      file: defaultShell(base),
      args: ['-ilc', 'claude auth login'],
      cwd: homedir(),
      env: buildSessionEnv(base, account),
      cols,
      rows
    })
    return null
  })

  ipcMain.on(IPC.ptyWrite, (_event, id: unknown, data: unknown) => {
    if (isText(id) && isText(data)) ptys.write(id, data)
  })
  ipcMain.on(IPC.ptyResize, (_event, id: unknown, cols: unknown, rows: unknown) => {
    if (isText(id) && isSize(cols) && isSize(rows)) ptys.resize(id, cols, rows)
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
}
