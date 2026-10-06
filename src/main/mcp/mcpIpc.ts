import { IPC } from '../../shared/ipc'
import type { McpInfo } from '../../shared/types'
import type { IpcTools } from '../ipcUtil'

export function registerMcpIpc(deps: { handle: IpcTools['handle']; getInfo: () => McpInfo }): void {
  deps.handle(IPC.mcpInfo, () => deps.getInfo())
}
