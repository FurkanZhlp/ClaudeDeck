import { IPC } from '../../shared/ipc'
import type { GuardEvaluateRequest, GuardRuleInfo } from '../../shared/types'
import type { IpcTools } from '../ipcUtil'
import type { GuardLog } from './guardLog'
import type { GuardService } from './guardService'

export interface GuardIpcDeps {
  /** Main window only: none of these channels is in the popover's allowlist. */
  handle: IpcTools['handle']
  service: Pick<GuardService, 'evaluate'>
  log: Pick<GuardLog, 'list'>
  rules(): GuardRuleInfo[]
}

export function registerGuardIpc({ handle, service, log, rules }: GuardIpcDeps): void {
  handle(IPC.guardRules, () => rules())
  handle(IPC.guardEvaluate, (request: GuardEvaluateRequest) => service.evaluate(request))
  handle(IPC.guardLog, () => log.list())
}
