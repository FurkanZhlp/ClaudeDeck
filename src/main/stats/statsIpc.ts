import { IPC } from '../../shared/ipc'
import type { IpcTools } from '../ipcUtil'
import type { StatsService } from './statsService'

interface Deps {
  handle: IpcTools['handle']
  service: Pick<StatsService, 'list'>
}

export function registerStatsIpc({ handle, service }: Deps): void {
  handle(IPC.usageStats, () => service.list())
}
