import { Folder, Pencil, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Account } from '@shared/types'
import { useOnboarding } from '../onboarding/onboardingStore'
import { OptimizeBadge } from '../optimize/OptimizeBadge'
import { useOptimizeBadgeState } from '../optimize/optimizeStore'
import { UsagePanel } from '../usage/UsagePanel'
import { useApp } from '../store'
import { SessionIcon, StatusDot } from '../ui/SessionIcon'
import { sectionTitleClass, tint } from '../ui/styles'

export function Sidebar(): React.JSX.Element | null {
  const { t } = useTranslation()
  const data = useApp((s) => s.data)
  const selectedAccountId = useApp((s) => s.selectedAccountId)
  const selectedProjectId = useApp((s) => s.selectedProjectId)
  const selectedSessionId = useApp((s) => s.selectedSessionId)
  const running = useApp((s) => s.running)
  const selectProject = useApp((s) => s.selectProject)
  const selectSession = useApp((s) => s.selectSession)
  const setProjectDialog = useApp((s) => s.setProjectDialog)
  if (!data) return null

  const account = data.accounts.find((a) => a.id === selectedAccountId)
  const projects = data.projects.filter((p) => p.accountId === selectedAccountId)

  return (
    <div className="flex shrink-0 flex-col border-r border-border bg-panel">
      {/* Shared title strip: room for the traffic lights, no divider running through them. */}
      <div className="drag h-11 shrink-0" />
      <div className="flex min-h-0 flex-1">
        <AccountRail />
        <aside className="flex w-60 flex-col">
          {account && <AccountHeader account={account} />}

          <div className="flex items-center justify-between px-3 pb-2 pt-3">
            <span className={sectionTitleClass}>{t('sidebar.projects')}</span>
            {account && (
              <button
                type="button"
                aria-label={t('sidebar.newProject')}
                data-tooltip={t('sidebar.newProject')}
                className="no-drag rounded p-1 text-muted hover:bg-elevated hover:text-fg"
                onClick={() => setProjectDialog({ mode: 'create' })}
              >
                <Plus size={14} />
              </button>
            )}
          </div>

          <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {account && projects.length === 0 && (
              <p className="px-2 py-3 text-muted">{t('sidebar.noProjectsForAccount')}</p>
            )}
            {account &&
              projects.map((project) => {
                const sessions = data.sessions.filter((s) => s.projectId === project.id)
                const active = project.id === selectedProjectId
                return (
                  <div key={project.id} className="mb-1">
                    <div
                      role="button"
                      tabIndex={0}
                      className={`group relative flex items-center gap-2 rounded-md py-1.5 pl-3 pr-2 transition-colors ${active ? 'bg-elevated' : 'hover:bg-elevated/60'}`}
                      onClick={() => selectProject(project.id)}
                      onKeyDown={(event) => event.key === 'Enter' && selectProject(project.id)}
                    >
                      {active && (
                        <span
                          aria-hidden
                          className="absolute inset-y-1.5 left-0 w-[3px] rounded-full"
                          style={{ background: account.color }}
                        />
                      )}
                      <Folder
                        size={14}
                        className="shrink-0"
                        style={{ color: active ? account.color : undefined }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{project.name}</div>
                        <div
                          className="truncate text-[11px] text-muted"
                          data-tooltip={project.path}
                        >
                          {shortPath(project.path)}
                        </div>
                      </div>
                      <button
                        type="button"
                        aria-label={t('sidebar.editProject')}
                        data-tooltip={t('sidebar.editProject')}
                        className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-fg focus:opacity-100"
                        onClick={(event) => {
                          event.stopPropagation()
                          setProjectDialog({ mode: 'edit', projectId: project.id })
                        }}
                      >
                        <Pencil size={12} />
                      </button>
                    </div>
                    {sessions.length > 0 && (
                      <ul
                        className="ml-4 mt-0.5 border-l pl-2"
                        style={{ borderColor: tint(account.color, 35) }}
                      >
                        {sessions.map((session) => (
                          <li key={session.id}>
                            <button
                              type="button"
                              className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left ${session.id === selectedSessionId ? 'text-fg' : 'text-muted hover:text-fg'}`}
                              onClick={() => selectSession(session.id)}
                            >
                              <SessionIcon kind={session.kind} size={12} />
                              <span className="min-w-0 flex-1 truncate">{session.title}</span>
                              <StatusDot run={running[session.id]} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })}
          </nav>

          <UsagePanel />
        </aside>
      </div>
    </div>
  )
}

function AccountHeader({ account }: { account: Account }): React.JSX.Element {
  const { t } = useTranslation()
  const status = useApp((s) => s.statuses[account.id])
  const detail =
    typeof status === 'object'
      ? status.loggedIn
        ? (status.email ?? t('settings.loggedIn'))
        : t('settings.loggedOut')
      : t('settings.checking')

  return (
    <div className="px-3 pb-3">
      <div className="truncate text-[15px] font-semibold">{account.name}</div>
      <div className="truncate text-[12px] text-muted">{detail}</div>
      <div
        aria-hidden
        className="mt-3 h-[2px] rounded-full transition-colors duration-300"
        style={{
          background: `linear-gradient(90deg, ${account.color}, ${tint(account.color, 0)})`
        }}
      />
    </div>
  )
}

/** Slack/Discord style account switcher: one coloured badge per account. */
function AccountRail(): React.JSX.Element {
  const { t } = useTranslation()
  const accounts = useApp((s) => s.data?.accounts ?? [])
  const selectedAccountId = useApp((s) => s.selectedAccountId)
  const selectAccount = useApp((s) => s.selectAccount)
  const setSettingsOpen = useApp((s) => s.setSettingsOpen)

  return (
    <nav
      aria-label={t('sidebar.accounts')}
      className="flex w-[68px] shrink-0 flex-col items-center border-r border-border pt-1"
    >
      <div
        role="tablist"
        aria-orientation="vertical"
        className="flex flex-col items-center gap-2.5"
      >
        {accounts.map((account) => (
          <RailItem
            key={account.id}
            account={account}
            active={account.id === selectedAccountId}
            onSelect={() => selectAccount(account.id)}
          />
        ))}
        <button
          type="button"
          aria-label={t('sidebar.addAccount')}
          data-tooltip={t('sidebar.addAccount')}
          data-tooltip-side="right"
          className="no-drag flex size-10 items-center justify-center rounded-xl border border-dashed border-border text-muted transition-colors hover:border-fg/30 hover:text-fg"
          onClick={() => setSettingsOpen(true)}
        >
          <Plus size={16} />
        </button>
      </div>
    </nav>
  )
}

function RailItem({
  account,
  active,
  onSelect
}: {
  account: Account
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const status = useApp((s) => s.statuses[account.id])
  const runningCount = useApp(
    (s) =>
      Object.values(s.running).filter((r) => r.accountId === account.id && r.exitCode === null)
        .length
  )
  const detail =
    typeof status === 'object'
      ? status.loggedIn
        ? status.email
        : t('settings.loggedOut')
      : undefined
  const optimize = useOptimizeBadgeState(account.id)
  const tooltip = [
    account.name,
    detail,
    runningCount > 0 ? t('sidebar.running', { count: runningCount }) : undefined,
    optimize ? t(`optimize.badge.${optimize}`) : undefined
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="flex w-full justify-center">
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-label={account.name}
        data-tooltip={tooltip}
        data-tooltip-side="right"
        onClick={() => {
          onSelect()
          // A proposal is waiting for an answer: take the user straight to it.
          if (optimize === 'waiting') {
            useOnboarding.getState().startForAccount(account.id, { startAt: 'optimize' })
          }
        }}
        className={`no-drag relative flex size-10 items-center justify-center rounded-xl text-[15px] font-semibold text-white transition-[opacity,box-shadow,filter] duration-200 ${active ? '' : 'opacity-55 saturate-[0.85] hover:opacity-100 hover:saturate-100'}`}
        style={{
          background: account.color,
          // Ring in the account colour with a gap in the panel colour marks the active account.
          boxShadow: active ? `0 0 0 2px var(--panel), 0 0 0 4px ${account.color}` : undefined
        }}
      >
        {account.name.trim().charAt(0).toLocaleUpperCase()}
        {runningCount > 0 && (
          <span
            aria-hidden
            className="absolute -right-1 -top-1 size-3 rounded-full border-2 border-panel bg-ok"
          />
        )}
        <OptimizeBadge accountId={account.id} />
      </button>
    </div>
  )
}

/** Last two path segments, enough to recognise a project folder. */
function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
}
