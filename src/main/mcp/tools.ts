import { isAbsolute, resolve, sep } from 'node:path'
import { z } from 'zod'
import { DomainError } from '../../shared/errors'
import type { NoteFile, Project, SessionKind } from '../../shared/types'
import { memoryDir } from '../notes/memoryPath'
import type { Repository } from '../state/repository'

export interface NotesAccess {
  list(dir: string): NoteFile[]
  read(dir: string, name: string): string
  write(dir: string, name: string, content: string): void
}

export interface ToolDeps {
  repo: Repository
  notes: NotesAccess
  requestOpenSession(sessionId: string): void
  notifyStateChanged(): void
}

/** MCP-shaped result, kept free of SDK types so the logic stays transport independent. */
export interface ToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

export interface Tool {
  description: string
  inputSchema: z.ZodRawShape
  call(args: unknown): Promise<ToolResult>
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
const DEFAULT_TITLES: Record<SessionKind, string> = { claude: 'Claude', shell: 'Terminal' }

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

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
})

const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true
})

function define<S extends z.ZodRawShape>(
  description: string,
  inputSchema: S,
  run: (args: z.infer<z.ZodObject<S>>) => unknown
): Tool {
  const schema = z.object(inputSchema).strict()
  return {
    description,
    inputSchema,
    async call(raw) {
      const parsed = schema.safeParse(raw ?? {})
      if (!parsed.success) return fail(`Invalid input: ${z.prettifyError(parsed.error)}`)
      try {
        return ok(await run(parsed.data))
      } catch (error) {
        if (error instanceof DomainError) return fail(ERROR_MESSAGES[error.code] ?? error.code)
        console.error('[mcp] tool failed', error)
        return fail('Internal error')
      }
    }
  }
}

/** Project whose folder equals or contains `path`; the deepest one wins. */
export function findProjectByPath(projects: Project[], path: string): Project | undefined {
  const target = resolve(path)
  let best: Project | undefined
  for (const project of projects) {
    const root = resolve(project.path)
    const inside = target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
    if (inside && (!best || root.length > resolve(best.path).length)) best = project
  }
  return best
}

export function createTools(deps: ToolDeps): Tools {
  const { repo, notes } = deps

  const describeProject = (p: Project): Record<string, string> => ({
    id: p.id,
    name: p.name,
    path: p.path,
    accountId: p.accountId,
    accountName: repo.get().accounts.find((a) => a.id === p.accountId)?.name ?? ''
  })

  const notesDir = (projectId: string): string => {
    const project = repo.project(projectId)
    return memoryDir(repo.account(project.accountId).configDir, project.path)
  }

  return {
    list_accounts: define('List the Claude Code accounts managed by ClaudeDeck.', {}, () =>
      repo.get().accounts.map((a) => ({ id: a.id, name: a.name, email: a.email ?? null }))
    ),

    list_projects: define('List ClaudeDeck projects with their folder and account.', {}, () =>
      repo.get().projects.map(describeProject)
    ),

    get_project: define(
      'Get a project by id, or by a path inside its folder (pass your cwd to find the current project).',
      { id: id.optional(), path: absPath.optional() },
      (args) => {
        if (args.id) return describeProject(repo.project(args.id))
        if (!args.path) throw new DomainError('INVALID')
        const project = findProjectByPath(repo.get().projects, args.path)
        if (!project) throw new DomainError('NOT_FOUND')
        return describeProject(project)
      }
    ),

    list_sessions: define('List the tabs (sessions) of a project.', { projectId: id }, (args) => {
      repo.project(args.projectId)
      return repo
        .get()
        .sessions.filter((s) => s.projectId === args.projectId)
        .map((s) => ({ id: s.id, title: s.title, kind: s.kind, createdAt: s.createdAt }))
    }),

    list_notes: define(
      "List the memory notes in a project's Claude Code memory folder.",
      { projectId: id },
      (args) => notes.list(notesDir(args.projectId))
    ),

    read_note: define(
      'Read one memory note of a project.',
      { projectId: id, name: noteName },
      (args) => ({ name: args.name, content: notes.read(notesDir(args.projectId), args.name) })
    ),

    write_note: define(
      'Create or overwrite a memory note of a project.',
      {
        projectId: id,
        name: noteName,
        content: z
          .string()
          .refine((c) => Buffer.byteLength(c, 'utf8') <= MAX_NOTE_BYTES, 'Note is too large')
      },
      (args) => {
        notes.write(notesDir(args.projectId), args.name, args.content)
        return { written: args.name }
      }
    ),

    create_project: define(
      'Create a ClaudeDeck project for a folder under an account.',
      { name: z.string().trim().min(1).max(200), path: absPath, accountId: id },
      (args) => {
        const before = new Set(repo.get().projects.map((p) => p.id))
        const state = repo.createProject(args)
        deps.notifyStateChanged()
        const created = state.projects.find((p) => !before.has(p.id))
        if (!created) throw new DomainError('UNKNOWN')
        return describeProject(created)
      }
    ),

    open_session: define(
      'Open a new Claude or terminal tab in a project and bring it to front in ClaudeDeck.',
      {
        projectId: id,
        kind: z.enum(['claude', 'shell']),
        title: z.string().trim().min(1).max(200).optional()
      },
      (args) => {
        repo.project(args.projectId)
        const count = repo
          .get()
          .sessions.filter((s) => s.projectId === args.projectId && s.kind === args.kind).length
        const title = args.title ?? `${DEFAULT_TITLES[args.kind]} ${count + 1}`
        const { session } = repo.createSession(args.projectId, args.kind, title)
        deps.notifyStateChanged()
        deps.requestOpenSession(session.id)
        return { id: session.id, title: session.title, kind: session.kind }
      }
    )
  }
}
