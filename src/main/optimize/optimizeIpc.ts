import { DomainError } from '../../shared/errors'
import { IPC } from '../../shared/ipc'
import type { OptimizeDecision } from '../../shared/types'
import { isText, type IpcTools } from '../ipcUtil'
import type { OptimizeManager } from './optimizeManager'

const DECISIONS = new Set<OptimizeDecision>(['apply', 'skip', 'modify'])
const MAX_ID = 200
const MAX_NOTE_BYTES = 4 * 1024

type Manager = Pick<OptimizeManager, 'start' | 'get' | 'list' | 'answer' | 'cancel' | 'revert'>

function accountIdOf(value: unknown): string {
  if (!isText(value) || value === '' || value.length > MAX_ID) throw new DomainError('INVALID')
  return value
}

function noteOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (!isText(value) || Buffer.byteLength(value, 'utf8') > MAX_NOTE_BYTES) {
    throw new DomainError('INVALID')
  }
  return value
}

export function registerOptimizeIpc(deps: { handle: IpcTools['handle']; manager: Manager }): void {
  const { handle, manager } = deps

  handle(IPC.optimizeStart, (accountId: unknown) => manager.start(accountIdOf(accountId)))
  handle(IPC.optimizeGet, (accountId: unknown) => manager.get(accountIdOf(accountId)))
  handle(IPC.optimizeList, () => manager.list())
  handle(
    IPC.optimizeAnswer,
    (accountId: unknown, questionId: unknown, decision: unknown, note: unknown) => {
      if (!isText(questionId) || questionId === '' || questionId.length > MAX_ID) {
        throw new DomainError('INVALID')
      }
      if (!DECISIONS.has(decision as OptimizeDecision)) throw new DomainError('INVALID')
      return manager.answer(
        accountIdOf(accountId),
        questionId,
        decision as OptimizeDecision,
        noteOf(note)
      )
    }
  )
  handle(IPC.optimizeCancel, (accountId: unknown) => manager.cancel(accountIdOf(accountId)))
  handle(IPC.optimizeRevert, (accountId: unknown) => manager.revert(accountIdOf(accountId)))
}
