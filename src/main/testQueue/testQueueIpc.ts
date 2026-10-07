import { DomainError } from '../../shared/errors'
import { IPC } from '../../shared/ipc'
import type {
  ClassifyResult,
  Project,
  TestQueueBuiltin,
  TestQueueSettings
} from '../../shared/types'
import type { IpcTools } from '../ipcUtil'
import type { ClassifyOptions } from './classifier'
import type { TestQueueHooks } from './testQueueHooks'
import type { TestQueueService } from './testQueueService'

/** Longest command "try a command" accepts; the classifier cuts at 16 KB anyway. */
const MAX_CLASSIFY_COMMAND = 64 * 1024

export interface TestQueueIpcDeps {
  /** Main window only: none of these channels is in the popover's allowlist. */
  handle: IpcTools['handle']
  service: TestQueueService
  hooks: Pick<TestQueueHooks, 'status'>
  settings(): TestQueueSettings
  /** Throws DomainError('NOT_FOUND') for an unknown project. */
  project(projectId: string): Project
  classify(command: string, opts: ClassifyOptions): ClassifyResult
  builtins(): TestQueueBuiltin[]
}

const runIdOf = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
    throw new DomainError('INVALID')
  }
  return value
}

export function registerTestQueueIpc(deps: TestQueueIpcDeps): void {
  const { handle, service } = deps
  handle(IPC.testQueueList, () => service.snapshot())
  handle(IPC.testQueueCancel, (runId: unknown) => service.cancel(runIdOf(runId)))
  handle(IPC.testQueueMove, (runId: unknown, position: unknown) => {
    if (typeof position !== 'number') throw new DomainError('INVALID')
    return service.move(runIdOf(runId), position)
  })
  handle(IPC.testQueueRunNow, (runId: unknown) => service.runNow(runIdOf(runId)))
  handle(IPC.testQueueRelease, (runId: unknown) => service.release(runIdOf(runId)))
  handle(IPC.testQueueStop, (runId: unknown) => service.stop(runIdOf(runId)))
  handle(IPC.testQueueClassify, (command: unknown, projectId: unknown) => {
    if (typeof command !== 'string' || command.length > MAX_CLASSIFY_COMMAND) {
      throw new DomainError('INVALID')
    }
    if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') {
      throw new DomainError('INVALID')
    }
    const s = deps.settings()
    return deps.classify(command, {
      disabledBuiltins: s.disabledBuiltins,
      customPatterns: s.customPatterns,
      projectOverrides: projectId ? deps.project(projectId).testQueue : undefined
    })
  })
  handle(IPC.testQueueHookStatus, () => deps.hooks.status())
  handle(IPC.testQueueBuiltins, () => deps.builtins())
}
