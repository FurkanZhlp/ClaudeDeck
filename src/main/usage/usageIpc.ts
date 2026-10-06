import { IPC } from '../../shared/ipc'
import type { IpcTools } from '../ipcUtil'
import type { UsageService } from './usageWatcher'

interface Deps {
  handle: IpcTools['handle']
  service: Pick<UsageService, 'list'>
}

export function registerUsageIpc({ handle, service }: Deps): void {
  handle(IPC.usageList, () => service.list())
}
