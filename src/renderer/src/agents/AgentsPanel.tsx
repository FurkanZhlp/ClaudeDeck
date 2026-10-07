import {
  AlertTriangle,
  ChevronLeft,
  CircleDot,
  Layers,
  ListOrdered,
  Workflow,
  X
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentSummary } from '@shared/types'
import { useNow } from '../optimize/hooks'
import { useApp } from '../store'
import { useSidePanel } from '../ui/sidePanelStore'
import { sectionTitleClass } from '../ui/styles'
import { AgentTranscript } from './AgentTranscript'
import { useAgents } from './agentsStore'
import { formatElapsed, shortModel } from './format'
import { Message, StatusDot } from './parts'
import './agents.css'

const iconButtonClass =
  'no-drag rounded p-1.5 text-muted transition-colors hover:bg-elevated hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40'

/** Left inset per nesting level (agents started by agents). */
const DEPTH_INDENT_PX = 14
const MAX_INDENT_DEPTH = 6

export function AgentsPanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const tabTitle = useApp((s) => s.data?.sessions.find((x) => x.id === sessionId)?.title ?? '')
  const setOpen = useSidePanel((s) => s.setOpen)
  const watched = useAgents((s) => s.sessionId === sessionId)
  const agents = useAgents((s) => (s.sessionId === sessionId ? s.agents : null))
  const listFailed = useAgents((s) => s.listFailed)
  const openId = useAgents((s) => (s.sessionId === sessionId ? (s.open?.agentId ?? null) : null))
  const openAgent = useAgents((s) => s.openAgent)
  const closeAgent = useAgents((s) => s.closeAgent)

  // Full mode is only kept while the panel shows it.
  useEffect(() => () => useAgents.getState().closeAgent(), [sessionId])

  // The elapsed times tick only while something runs and the panel is visible.
  const anyRunning = agents?.some((a) => a.status === 'running') ?? false
  const now = useNow(anyRunning)

  // Entering the detail view moves focus to its back button (Escape also goes back).
  const backRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (openId) backRef.current?.focus()
  }, [openId])

  const selected = openId ? (agents?.find((a) => a.agentId === openId) ?? null) : null

  return (
    <aside
      aria-label={t('agents.title')}
      className="agents-panel-in flex w-[360px] shrink-0 flex-col border-l border-border bg-panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && openId) {
          event.stopPropagation()
          closeAgent()
        }
      }}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border pl-2 pr-2">
        {openId ? (
          <button
            ref={backRef}
            type="button"
            className={iconButtonClass}
            aria-label={t('agents.back')}
            data-tooltip={t('agents.back')}
            onClick={closeAgent}
          >
            <ChevronLeft size={15} />
          </button>
        ) : (
          <Workflow size={15} className="ml-2 shrink-0 text-muted" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          {openId ? (
            <nav aria-label={t('agents.breadcrumb')}>
              <ol className="flex min-w-0 items-center gap-1 text-[11px] leading-tight text-muted">
                <li className="shrink-0">
                  <button
                    type="button"
                    className="rounded hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    onClick={closeAgent}
                  >
                    {t('agents.title')}
                  </button>
                </li>
                <li aria-hidden className="shrink-0">
                  /
                </li>
                <li className="truncate" aria-current="page">
                  {selected?.agentType ?? openId}
                </li>
              </ol>
              <h2 className="truncate text-[13px] font-semibold leading-tight">
                {selected?.description || selected?.agentType || openId}
              </h2>
            </nav>
          ) : (
            <>
              <h2 className="truncate text-[13px] font-semibold leading-tight">
                {t('agents.title')}
              </h2>
              <div className="truncate text-[11px] leading-tight text-muted">{tabTitle}</div>
            </>
          )}
        </div>
        <button
          type="button"
          className={iconButtonClass}
          aria-label={t('agents.close')}
          data-tooltip={t('agents.close')}
          onClick={() => setOpen('agents', false)}
        >
          <X size={15} />
        </button>
      </header>

      {openId ? (
        <AgentTranscript key={openId} agent={selected} now={now} />
      ) : !watched || agents === null ? (
        <ListSkeleton />
      ) : listFailed ? (
        <Message icon={<AlertTriangle size={20} aria-hidden />} title={t('agents.loadFailed')} />
      ) : agents.length === 0 ? (
        <Message
          icon={<Workflow size={20} aria-hidden />}
          title={t('agents.emptyTitle')}
          body={t('agents.emptyBody')}
        />
      ) : (
        <AgentList agents={agents} now={now} onOpen={(id) => void openAgent(id)} />
      )}
    </aside>
  )
}

function AgentList({
  agents,
  now,
  onOpen
}: {
  agents: AgentSummary[]
  now: number
  onOpen: (agentId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const running = agents.filter((a) => a.status === 'running').length
  return (
    <div className="scroll-area min-h-0 flex-1 overflow-y-auto">
      <div className={`flex items-center justify-between px-4 pb-1 pt-3 ${sectionTitleClass}`}>
        <span>{t('agents.listLabel')}</span>
        <span className="normal-case tracking-normal tabular-nums" aria-live="polite">
          {t('agents.runningCount', { count: running })}
        </span>
      </div>
      <ul aria-label={t('agents.listLabel')} className="px-2 pb-2">
        {agents.map((agent) => (
          <li key={agent.agentId} className="agents-row">
            <AgentRow agent={agent} now={now} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function AgentRow({
  agent,
  now,
  onOpen
}: {
  agent: AgentSummary
  now: number
  onOpen: (agentId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const depth = Math.min(Math.max(agent.depth, 1), MAX_INDENT_DEPTH) - 1
  const end = agent.status === 'running' ? now : agent.lastActivityAt
  const elapsed = formatElapsed(end - agent.startedAt)
  const title = agent.description || agent.agentType

  return (
    <button
      type="button"
      className="group relative flex w-full items-start gap-2.5 rounded-md py-2 pr-2 text-left outline-none transition-colors hover:bg-elevated focus-visible:ring-2 focus-visible:ring-accent"
      style={{ paddingLeft: 8 + depth * DEPTH_INDENT_PX }}
      aria-label={`${title}, ${t(`agents.status.${agent.status}`)}, ${t('agents.elapsed', { time: elapsed })}`}
      onClick={() => onOpen(agent.agentId)}
    >
      {depth > 0 && (
        <span
          aria-hidden
          className="agents-depth-guide"
          style={{ left: 2 + depth * DEPTH_INDENT_PX }}
        />
      )}
      <StatusDot status={agent.status} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate rounded bg-elevated px-1.5 py-px text-[11px] font-medium text-fg ring-1 ring-border group-hover:bg-panel">
            {agent.agentType}
          </span>
          {agent.model && (
            <span className="shrink-0 rounded px-1 text-[10.5px] text-muted ring-1 ring-border">
              {shortModel(agent.model)}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted">
            <span
              data-tooltip={agent.background ? t('agents.background') : t('agents.foreground')}
              aria-hidden
            >
              {agent.background ? <Layers size={12} /> : <CircleDot size={12} />}
            </span>
            <time className="tabular-nums">{elapsed}</time>
          </span>
        </span>
        <span className="mt-1 block truncate text-[12.5px] leading-snug text-fg">{title}</span>
        {agent.currentTool && (
          <span
            className="mt-0.5 block truncate font-mono text-[11px] text-muted"
            title={agent.currentToolInput}
          >
            {t('agents.currentTool', {
              tool: agent.currentToolInput
                ? `${agent.currentTool} · ${agent.currentToolInput}`
                : agent.currentTool
            })}
          </span>
        )}
        {agent.queuedRunId && (
          <span className="mt-1 inline-flex items-center gap-1 rounded bg-elevated px-1.5 py-px text-[11px] font-medium text-warn ring-1 ring-warn/40">
            <ListOrdered size={11} aria-hidden />
            {t('agents.queued')}
          </span>
        )}
      </span>
    </button>
  )
}

function ListSkeleton(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div role="status" aria-label={t('agents.loading')} className="flex flex-col gap-2 p-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="agents-skeleton h-14 rounded-md bg-elevated" />
      ))}
    </div>
  )
}
