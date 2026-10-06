import { DomainError } from '../../shared/errors'
import { IPC } from '../../shared/ipc'
import type { Account, AccountPlan } from '../../shared/types'
import type { IpcTools } from '../ipcUtil'
import { readAccountPlan } from './plan'
import type { UsagePoller } from './usagePoller'
import type { UsageService } from './usageWatcher'

interface Deps {
  handle: IpcTools['handle']
  service: Pick<UsageService, 'list'>
  // Optional so the app keeps building until the poller is wired in.
  poller?: Pick<UsagePoller, 'pollNow'>
  repo?: { get(): { accounts: Account[] } }
  readPlan?: (account: Account) => AccountPlan
}

export function registerUsageIpc({
  handle,
  service,
  poller,
  repo,
  readPlan = readAccountPlan
}: Deps): void {
  handle(IPC.usageList, () => service.list())
  // Forced: ignores reading age and backoff; the poller still runs one process at a time.
  handle(IPC.usagePollNow, (accountId?: unknown) => {
    if (accountId !== undefined && accountId !== null && typeof accountId !== 'string') {
      throw new DomainError('INVALID')
    }
    poller?.pollNow(typeof accountId === 'string' ? accountId : undefined)
    return null
  })
  handle(IPC.usagePlans, () => (repo ? repo.get().accounts.map((a) => readPlan(a)) : []))
}
