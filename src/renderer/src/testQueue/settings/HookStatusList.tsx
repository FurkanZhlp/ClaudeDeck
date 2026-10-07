import { CircleCheck, CircleDashed, RotateCw, TriangleAlert } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { TestQueueAccountHookStatus } from '@shared/types'
import { formatRelative } from '../../notes/relativeTime'
import { isWindows } from '../../platform'
import { useApp } from '../../store'
import { AccountDot } from '../../ui/AccountDot'
import { Notice } from '../../ui/Notice'
import { useTestQueue } from '../testQueueStore'

/** Per account: whether the hook is in its settings.json and when it last called in. */
export function HookStatusList(): React.JSX.Element {
  const { t } = useTranslation()
  const status = useTestQueue((s) => s.hookStatus)
  const accounts = useApp((s) => s.data?.accounts) ?? []
  const projects = useApp((s) => s.data?.projects) ?? []

  useEffect(() => {
    void useTestQueue.getState().loadHookStatus()
  }, [])

  if (!status) return <p className="text-[12px] text-muted">{t('testQueue.loading')}</p>
  const disabledProjects = projects.filter((p) => status.hooksDisabledProjectIds.includes(p.id))

  return (
    <div className="space-y-2">
      {status.managedHooksOnly && <Notice tone="warn">{t('testQueue.hooks.managedOnly')}</Notice>}
      {disabledProjects.length > 0 && (
        <Notice tone="warn">
          {t('testQueue.hooks.projectsDisabled', {
            projects: disabledProjects.map((p) => p.name).join(', ')
          })}
        </Notice>
      )}
      <ul className="divide-y divide-border rounded-lg border border-border">
        {accounts.map((account) => {
          const entry = status.accounts.find((a) => a.accountId === account.id)
          return (
            <li key={account.id} className="flex items-center gap-2.5 px-3 py-2">
              <AccountDot color={account.color} size={8} />
              <span className="min-w-0 flex-1 truncate">{account.name}</span>
              <HookState entry={entry} />
            </li>
          )
        })}
      </ul>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12px] leading-snug text-muted">
          {isWindows ? t('testQueue.hooks.bashOnlyWindows') : t('testQueue.hooks.bashOnly')}
        </p>
        <button
          type="button"
          aria-label={t('testQueue.hooks.refresh')}
          data-tooltip={t('testQueue.hooks.refresh')}
          className="shrink-0 rounded p-1 text-muted hover:bg-fg/[0.08] hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
          onClick={() => void useTestQueue.getState().loadHookStatus()}
        >
          <RotateCw size={13} />
        </button>
      </div>
    </div>
  )
}

function HookState({
  entry
}: {
  entry: TestQueueAccountHookStatus | undefined
}): React.JSX.Element {
  const { t, i18n } = useTranslation()

  if (entry?.problem) {
    return (
      <span className="flex min-w-0 items-center gap-1 text-[12px] text-warn">
        <TriangleAlert size={12} aria-hidden className="shrink-0" />
        <span
          tabIndex={0}
          className="truncate"
          data-tooltip={t(`testQueue.hooks.problem.${entry.problem}`)}
        >
          {t(`testQueue.hooks.problemShort.${entry.problem}`)}
        </span>
      </span>
    )
  }
  if (!entry?.installed) {
    return (
      <span className="flex items-center gap-1 text-[12px] text-muted">
        <CircleDashed size={12} aria-hidden />
        {t('testQueue.hooks.notInstalled')}
      </span>
    )
  }
  const last = entry.lastCallAt
    ? t('testQueue.hooks.lastCall', { time: formatRelative(entry.lastCallAt, i18n.language) })
    : t('testQueue.hooks.noCalls')
  return (
    <span className="flex min-w-0 items-center gap-1 text-[12px] text-ok">
      <CircleCheck size={12} aria-hidden className="shrink-0" />
      <span className="truncate">
        {t('testQueue.hooks.installed')}
        <span className="text-muted"> · {last}</span>
      </span>
    </span>
  )
}
