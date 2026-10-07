import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as nodePath from 'node:path'
import { isAbsolute, type PlatformPath } from 'node:path'
import { z } from 'zod'
import { DomainError } from '../../shared/errors'
import type { NoteFile, Project, SessionKind } from '../../shared/types'
import { memoryDir } from '../notes/memoryPath'
import type { OsName } from '../platform/types'
import { isRootPath, isWindowsUncPath, isWithin, samePath } from '../platform/paths'
import type { Repository } from '../state/repository'
import type { McpScope, McpScopeKind, SessionScope } from './sessionTokens'

export interface NotesAccess {
  list(dir: string): NoteFile[]
  read(dir: string, name: string): string
  write(dir: string, name: string, content: string): void
}

/** Something a Claude tab wants to do that changes the app; the user approves it in the UI. */
export type ConfirmRequest =
  | {
      kind: 'create_project'
      name: string
      path: string
      accountId: string
      requestedBy: SessionScope
    }
  | {
      kind: 'open_session'
      projectId: string
      sessionKind: SessionKind
      title: string
      requestedBy: SessionScope
    }

export interface ToolDeps {
  repo: Repository
  notes: NotesAccess
  requestOpenSession(sessionId: string): void
  notifyStateChanged(): void
  /** Resolves true only when the user approved the request. */
  confirm: (req: ConfirmRequest) => Promise<boolean>
  /** Overrides the confirmation timeout (tests). */
  confirmTimeoutMs?: number
}

/** MCP-shaped result, kept free of SDK types so the logic stays transport independent. */
export interface ToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

export interface Tool {
  /** Only tokens of this scope kind see and may call the tool. */
  scopeKind: McpScopeKind
  description: string
  inputSchema: z.ZodRawShape
  call(args: unknown, scope: McpScope): Promise<ToolResult>
}

export type ToolName =
  | 'list_accounts'
  | 'list_projects'
  | 'get_project'
  | 'list_sessions'
  | 'list_notes'
  | 'read_note'
  | 'write_note'
  | 'create_project'
  | 'open_session'

export type Tools = Record<ToolName, Tool>

const MAX_NOTE_BYTES = 1024 * 1024
const MAX_NOTES_PER_PROJECT = 200
const MAX_NOTES_TOTAL_BYTES = 5 * 1024 * 1024
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_TITLES: Record<SessionKind, string> = { claude: 'Claude', shell: 'Terminal' }
const DECLINED_TEXT = 'The user declined.'
// System locations a project folder must never point into (checked after realpath).
const POSIX_BLOCKED_ROOTS = [
  '/System',
  '/Library',
  '/bin',
  '/sbin',
  '/usr',
  '/etc',
  '/private/etc',
  '/Applications'
]
/** Windows system folders: env variable that names each, and its usual location. */
const WINDOWS_BLOCKED_ROOTS: readonly (readonly [string, string])[] = [
  ['SystemRoot', 'C:\\Windows'],
  ['windir', 'C:\\Windows'],
  ['ProgramFiles', 'C:\\Program Files'],
  ['ProgramFiles(x86)', 'C:\\Program Files (x86)'],
  ['ProgramW6432', 'C:\\Program Files'],
  ['ProgramData', 'C:\\ProgramData']
]

const id = z.string().trim().min(1).max(200)
const absPath = z.string().trim().min(1).max(4096).refine(isAbsolute, 'Path must be absolute')
const noteName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((n) => !/[/\\\0]/.test(n) && n !== '.' && n !== '..', 'Invalid note name')

const ERROR_MESSAGES: Record<string, string> = {
  NOT_FOUND: 'Not found',
  INVALID: 'Invalid input',
  PATH_MISSING: 'Path does not exist'
}

/** Error whose message is safe to show to the MCP client as is. */
export class ToolError extends Error {}

/** Handler result sent to the client as plain text instead of JSON. */
export class TextReply {
  constructor(readonly text: string) {}
}

const notAllowed = (): ToolError => new ToolError('Not allowed')

// Returned by a handler when the user said no; reported as a normal (non-error) result.
const DECLINED = Symbol('declined')

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
})

const text = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }] })

const fail = (message: string): ToolResult => ({ ...text(message), isError: true })

type ScopeOf<K extends McpScopeKind> = Extract<McpScope, { kind: K }>

/** A zod-validated tool that only callers of scope kind `kind` may use. */
export function defineTool<K extends McpScopeKind, S extends z.ZodRawShape>(
  kind: K,
  description: string,
  inputSchema: S,
  run: (args: z.infer<z.ZodObject<S>>, scope: ScopeOf<K>) => unknown
): Tool {
  const schema = z.object(inputSchema).strict()
  return {
    scopeKind: kind,
    description,
    inputSchema,
    async call(raw, scope) {
      if (scope.kind !== kind) return fail('Not allowed')
      const parsed = schema.safeParse(raw ?? {})
      if (!parsed.success) return fail(`Invalid input: ${z.prettifyError(parsed.error)}`)
      try {
        const result = await run(parsed.data, scope as ScopeOf<K>)
        if (result === DECLINED) return text(DECLINED_TEXT)
        return result instanceof TextReply ? text(result.text) : ok(result)
      } catch (error) {
        if (error instanceof ToolError) return fail(error.message)
        if (error instanceof DomainError) return fail(ERROR_MESSAGES[error.code] ?? error.code)
        console.error('[mcp] tool failed', error)
        return fail('Internal error')
      }
    }
  }
}

/** Project and notes tools: Claude tabs only. */
const define = <S extends z.ZodRawShape>(
  description: string,
  inputSchema: S,
  run: (args: z.infer<z.ZodObject<S>>, scope: SessionScope) => unknown
): Tool => defineTool('session', description, inputSchema, run)

/** Path flavour of an OS: Windows paths are compared case-insensitively. */
const pathOf = (os: OsName): PlatformPath => (os === 'win32' ? nodePath.win32 : nodePath.posix)

const within = (path: string, root: string, p: PlatformPath): boolean =>
  p === nodePath.win32
    ? isWithin(path, root, p)
    : path === root || path.startsWith(root.endsWith(p.sep) ? root : root + p.sep)

/** Project whose folder equals or contains `path`; the deepest one wins. */
export function findProjectByPath(
  projects: Project[],
  path: string,
  os: OsName = process.platform
): Project | undefined {
  const p = pathOf(os)
  const target = p.resolve(path)
  let best: Project | undefined
  for (const project of projects) {
    const root = p.resolve(project.path)
    if (within(target, root, p) && (!best || root.length > p.resolve(best.path).length)) {
      best = project
    }
  }
  return best
}

/**
 * Folders a project may not be or lie in. Windows ones come from the env (case-insensitive
 * names) with the usual locations as fallback, so a renamed or moved system drive stays covered.
 */
export function blockedRoots(os: OsName, env: NodeJS.ProcessEnv = process.env): string[] {
  if (os !== 'win32') return POSIX_BLOCKED_ROOTS
  const lookup = (name: string): string | undefined => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
    const value = key ? env[key]?.trim() : undefined
    return value || undefined
  }
  const roots = WINDOWS_BLOCKED_ROOTS.flatMap(([name, fallback]) => [lookup(name), fallback])
  const unique: string[] = []
  for (const root of roots) {
    if (root && !unique.some((r) => samePath(r, root, nodePath.win32))) unique.push(root)
  }
  return unique
}

/** File system access of resolveProjectFolder; tests pass Windows fakes. */
export interface ProjectFolderDeps {
  os?: OsName
  env?: NodeJS.ProcessEnv
  realpath?: (path: string) => string
  isDirectory?: (path: string) => boolean
  home?: string
}

/**
 * True when a resolved folder is a file system root, the user's home, or inside a system
 * location. Windows comparisons ignore case and accept both separators.
 */
export function isBlockedProjectFolder(
  real: string,
  home: string,
  os: OsName,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const p = pathOf(os)
  return (
    isRootPath(real, p) ||
    samePath(real, home, p) ||
    blockedRoots(os, env).some((root) => within(real, root, p))
  )
}

/** Realpath of an existing directory that is safe to use as a project folder. */
export function resolveProjectFolder(path: string, deps: ProjectFolderDeps = {}): string {
  const os = deps.os ?? process.platform
  const realpath = deps.realpath ?? realpathSync
  // Checked before touching the path: resolving a share would reach the network.
  if (os === 'win32' && isWindowsUncPath(path)) throw new ToolError('Path not allowed')
  let real: string
  try {
    real = realpath(path)
  } catch {
    throw new DomainError('PATH_MISSING')
  }
  // A local path may still resolve onto a share (mapped drive link, junction).
  if (os === 'win32' && isWindowsUncPath(real)) throw new ToolError('Path not allowed')
  const isDirectory = deps.isDirectory ?? ((dir: string) => statSync(dir).isDirectory())
  if (!isDirectory(real)) throw new ToolError('Path is not a directory')
  let home = deps.home ?? homedir()
  try {
    home = realpath(home)
  } catch {
    // Keep the unresolved home dir.
  }
  if (isBlockedProjectFolder(real, home, os, deps.env)) throw new ToolError('Path not allowed')
  return real
}

export function createTools(deps: ToolDeps): Tools {
  const { repo, notes } = deps
  const timeoutMs = deps.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS
  const pendingConfirms = new Set<string>()

  const describeProject = (p: Project): Record<string, string> => ({
    id: p.id,
    name: p.name,
    path: p.path,
    accountId: p.accountId,
    accountName: repo.get().accounts.find((a) => a.id === p.accountId)?.name ?? ''
  })

  const accountProjects = (scope: SessionScope): Project[] =>
    repo.get().projects.filter((p) => p.accountId === scope.accountId)

  /** A project of the caller's account. */
  const ownAccountProject = (scope: SessionScope, projectId: string): Project => {
    const project = accountProjects(scope).find((p) => p.id === projectId)
    if (!project) throw notAllowed()
    return project
  }

  /** The caller's own project; any other id is refused. */
  const ownProjectId = (scope: SessionScope, projectId: string | undefined): string => {
    const target = projectId ?? scope.projectId
    if (target !== scope.projectId) throw notAllowed()
    repo.project(target)
    return target
  }

  const notesDir = (projectId: string): string => {
    const project = repo.project(projectId)
    return memoryDir(repo.account(project.accountId).configDir, project.path)
  }

  /** Asks the user once per tab at a time; a timeout or failure counts as a no. */
  const ask = async (req: ConfirmRequest): Promise<boolean> => {
    const sessionId = req.requestedBy.sessionId
    if (pendingConfirms.has(sessionId)) {
      throw new ToolError('Another request from this tab is waiting for the user.')
    }
    pendingConfirms.add(sessionId)
    let timer: NodeJS.Timeout | undefined
    try {
      const timeout = new Promise<boolean>((done) => {
        timer = setTimeout(() => done(false), timeoutMs)
      })
      return (await Promise.race([deps.confirm(req), timeout])) === true
    } catch (error) {
      console.warn('[mcp] confirmation failed', error)
      return false
    } finally {
      clearTimeout(timer)
      pendingConfirms.delete(sessionId)
    }
  }

  return {
    list_accounts: define('List the Claude Code account this tab runs under.', {}, (_, scope) =>
      repo
        .get()
        .accounts.filter((a) => a.id === scope.accountId)
        .map((a) => ({ id: a.id, name: a.name }))
    ),

    list_projects: define(
      'List the ClaudeDeck projects of this account with their folder.',
      {},
      (_, scope) => accountProjects(scope).map(describeProject)
    ),

    get_project: define(
      'Get a project of this account by id, or by a path inside its folder (pass your cwd to find the current project).',
      { id: id.optional(), path: absPath.optional() },
      (args, scope) => {
        if (args.id) return describeProject(ownAccountProject(scope, args.id))
        if (!args.path) throw new DomainError('INVALID')
        const project = findProjectByPath(accountProjects(scope), args.path)
        if (!project) throw new DomainError('NOT_FOUND')
        return describeProject(project)
      }
    ),

    list_sessions: define(
      'List the tabs (sessions) of the current project.',
      { projectId: id.optional() },
      (args, scope) => {
        const projectId = ownProjectId(scope, args.projectId)
        return repo
          .get()
          .sessions.filter((s) => s.projectId === projectId)
          .map((s) => ({ id: s.id, title: s.title, kind: s.kind, createdAt: s.createdAt }))
      }
    ),

    list_notes: define(
      "List the memory notes in the current project's Claude Code memory folder.",
      { projectId: id.optional() },
      (args, scope) => notes.list(notesDir(ownProjectId(scope, args.projectId)))
    ),

    read_note: define(
      'Read one memory note of the current project.',
      { projectId: id.optional(), name: noteName },
      (args, scope) => ({
        name: args.name,
        content: notes.read(notesDir(ownProjectId(scope, args.projectId)), args.name)
      })
    ),

    write_note: define(
      'Create or overwrite a memory note of the current project.',
      {
        projectId: id.optional(),
        name: noteName,
        content: z
          .string()
          .refine((c) => Buffer.byteLength(c, 'utf8') <= MAX_NOTE_BYTES, 'Note is too large')
      },
      (args, scope) => {
        const dir = notesDir(ownProjectId(scope, args.projectId))
        const others = notes.list(dir).filter((n) => n.name !== args.name)
        const total = others.reduce((sum, n) => sum + n.size, 0)
        if (others.length >= MAX_NOTES_PER_PROJECT) {
          throw new ToolError(`Too many notes (max ${MAX_NOTES_PER_PROJECT} per project)`)
        }
        if (total + Buffer.byteLength(args.content, 'utf8') > MAX_NOTES_TOTAL_BYTES) {
          throw new ToolError('Notes of this project would exceed 5 MB')
        }
        notes.write(dir, args.name, args.content)
        return { written: args.name }
      }
    ),

    create_project: define(
      'Ask the user to add a folder as a ClaudeDeck project under this account.',
      { name: z.string().trim().min(1).max(200), path: absPath, accountId: id.optional() },
      async (args, scope) => {
        if (args.accountId !== undefined && args.accountId !== scope.accountId) throw notAllowed()
        repo.account(scope.accountId)
        const path = resolveProjectFolder(args.path)
        const approved = await ask({
          kind: 'create_project',
          name: args.name,
          path,
          accountId: scope.accountId,
          requestedBy: scope
        })
        if (!approved) return DECLINED

        const before = new Set(repo.get().projects.map((p) => p.id))
        const state = repo.createProject({ name: args.name, path, accountId: scope.accountId })
        deps.notifyStateChanged()
        const created = state.projects.find((p) => !before.has(p.id))
        if (!created) throw new DomainError('UNKNOWN')
        return describeProject(created)
      }
    ),

    open_session: define(
      'Ask the user to open a new Claude or terminal tab in a project of this account. The tab is shown but not started.',
      {
        projectId: id,
        kind: z.enum(['claude', 'shell']),
        title: z.string().trim().min(1).max(200).optional()
      },
      async (args, scope) => {
        const countTabs = (): number =>
          repo.get().sessions.filter((s) => s.projectId === args.projectId && s.kind === args.kind)
            .length
        ownAccountProject(scope, args.projectId)
        const approved = await ask({
          kind: 'open_session',
          projectId: args.projectId,
          sessionKind: args.kind,
          title: args.title ?? `${DEFAULT_TITLES[args.kind]} ${countTabs() + 1}`,
          requestedBy: scope
        })
        if (!approved) return DECLINED

        // The project may have moved or gone while the user was deciding.
        ownAccountProject(scope, args.projectId)
        const title = args.title ?? `${DEFAULT_TITLES[args.kind]} ${countTabs() + 1}`
        const { session } = repo.createSession(args.projectId, args.kind, title)
        deps.notifyStateChanged()
        deps.requestOpenSession(session.id)
        return { id: session.id, title: session.title, kind: session.kind }
      }
    )
  }
}
