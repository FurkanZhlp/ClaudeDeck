import { DomainError } from '../../shared/errors'
import { IPC } from '../../shared/ipc'
import type { AssistantStartInput } from '../../shared/assistant'
import { isText, type IpcTools } from '../ipcUtil'
import type { AssistantManager } from './assistantManager'

type Manager = Pick<AssistantManager, 'start' | 'followUp' | 'cancel' | 'apply' | 'reject' | 'undo'>

const MAX_ID = 200
const MAX_CONFIRMATIONS = 20

function idOf(value: unknown): string {
  if (!isText(value) || value === '' || value.length > MAX_ID) throw new DomainError('INVALID')
  return value
}

function startInput(value: unknown): AssistantStartInput {
  if (!value || typeof value !== 'object') throw new DomainError('INVALID')
  const { prompt, accountId, section, projectId } = value as Record<string, unknown>
  if (!isText(prompt)) throw new DomainError('INVALID')
  return {
    prompt,
    accountId: idOf(accountId),
    ...(section !== undefined && section !== null ? { section: section as never } : {}),
    ...(projectId !== undefined && projectId !== null ? { projectId: idOf(projectId) } : {})
  }
}

function confirmationsOf(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_CONFIRMATIONS || !value.every(isText)) {
    throw new DomainError('INVALID')
  }
  return value
}

/** Main window only: none of these channels is in the menu bar popover's allowlist. */
export function registerAssistantIpc(deps: { handle: IpcTools['handle']; manager: Manager }): void {
  const { handle, manager } = deps
  handle(IPC.assistantStart, (input: unknown) => manager.start(startInput(input)))
  handle(IPC.assistantFollowUp, (runId: unknown, text: unknown) => {
    if (!isText(text)) throw new DomainError('INVALID')
    return manager.followUp(idOf(runId), text)
  })
  handle(IPC.assistantCancel, (runId: unknown) => manager.cancel(idOf(runId)))
  handle(IPC.assistantApply, (proposalId: unknown, confirmed: unknown) =>
    manager.apply(idOf(proposalId), confirmationsOf(confirmed))
  )
  handle(IPC.assistantReject, (proposalId: unknown) => manager.reject(idOf(proposalId)))
  handle(IPC.assistantUndo, (token: unknown) => manager.undo(idOf(token)))
}
