import {
  AlertTriangle,
  ArrowDown,
  Brain,
  Check,
  ChevronRight,
  Info,
  Loader2,
  Wrench,
  X
} from 'lucide-react'
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentEvent, AgentSummary } from '@shared/types'
import { useAgents } from './agentsStore'
import { firstLine, formatElapsed, shortModel, splitLinks } from './format'
import { Message, StatusDot } from './parts'
import { toItems, type TranscriptItem } from './transcript'

/** Distance from the bottom (px) that still counts as "following" the live output. */
const STICK_THRESHOLD_PX = 32

const preClass =
  'mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border px-2.5 py-2 font-mono text-[11.5px] leading-relaxed select-text'

export function AgentTranscript({
  agent,
  now
}: {
  agent: AgentSummary | null
  now: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const open = useAgents((s) => s.open)
  const loadOlder = useAgents((s) => s.loadOlder)
  const closeAgent = useAgents((s) => s.closeAgent)
  const items = useMemo(() => toItems(open?.events ?? []), [open?.events])
  const running = agent?.status === 'running'

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  /** Scroll height before older events were prepended, to keep the view in place. */
  const anchorRef = useRef<number | null>(null)
  const [atBottom, setAtBottom] = useState(true)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (anchorRef.current !== null) {
      el.scrollTop += el.scrollHeight - anchorRef.current
      anchorRef.current = null
    } else if (stickRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [items])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX
    stickRef.current = bottom
    if (bottom !== atBottom) setAtBottom(bottom)
  }

  const older = (): void => {
    anchorRef.current = scrollRef.current?.scrollHeight ?? null
    void loadOlder()
  }

  const jumpToLatest = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = true
    setAtBottom(true)
    el.scrollTo({ top: el.scrollHeight })
  }

  if (!open || open.failed) {
    return (
      <div className="flex flex-1 flex-col">
        <Message icon={<AlertTriangle size={20} aria-hidden />} title={t('agents.openFailed')} />
        <div className="flex justify-center pb-8">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-[13px] font-medium text-muted hover:bg-elevated hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={closeAgent}
          >
            {t('agents.backToList')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {agent && <AgentMeta agent={agent} now={now} />}
      <div
        ref={scrollRef}
        role="log"
        aria-live="off"
        aria-label={t('agents.transcript')}
        aria-busy={open.loading}
        className="scroll-area min-h-0 flex-1 overflow-y-auto bg-elevated"
        onScroll={onScroll}
      >
        {open.cursor !== null && !open.loading && (
          <div className="flex justify-center pt-3">
            <button
              type="button"
              disabled={open.loadingOlder}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 py-1 text-[12px] text-muted hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
              onClick={older}
            >
              {open.loadingOlder && <Loader2 size={12} className="motion-safe:animate-spin" />}
              {t('agents.older')}
            </button>
          </div>
        )}
        {open.loading ? (
          <div role="status" className="flex items-center justify-center gap-2 py-10 text-muted">
            <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden />
            {t('agents.loadingTranscript')}
          </div>
        ) : items.length === 0 ? (
          <p className="px-5 py-8 text-center text-muted">{t('agents.emptyTranscript')}</p>
        ) : (
          <ol className="flex flex-col gap-3 px-4 py-4">
            {items.map((item) => (
              <li
                key={item.type === 'tool' ? item.call.id : item.event.id}
                className="agents-entry"
              >
                <Entry item={item} running={running} />
              </li>
            ))}
          </ol>
        )}
      </div>
      {!atBottom && (
        <button
          type="button"
          className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-panel px-3 py-1 text-[12px] font-medium text-fg shadow-sm hover:bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          onClick={jumpToLatest}
        >
          <ArrowDown size={12} aria-hidden />
          {t('agents.jumpToLatest')}
        </button>
      )}
    </div>
  )
}

function AgentMeta({ agent, now }: { agent: AgentSummary; now: number }): React.JSX.Element {
  const { t } = useTranslation()
  const end = agent.status === 'running' ? now : agent.lastActivityAt
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-2 text-[11.5px] text-muted">
      <span className="inline-flex items-center gap-1.5">
        <StatusDot status={agent.status} className="" />
        <span className="text-fg">{t(`agents.status.${agent.status}`)}</span>
      </span>
      <span aria-hidden>·</span>
      <span>{agent.background ? t('agents.background') : t('agents.foreground')}</span>
      {agent.model && (
        <>
          <span aria-hidden>·</span>
          <span>{shortModel(agent.model)}</span>
        </>
      )}
      <span aria-hidden>·</span>
      <time className="tabular-nums">{formatElapsed(end - agent.startedAt)}</time>
      {agent.queuedRunId && (
        <span className="rounded bg-elevated px-1.5 py-px font-medium text-warn ring-1 ring-warn/40">
          {t('agents.queued')}
        </span>
      )}
    </div>
  )
}

function Entry({ item, running }: { item: TranscriptItem; running: boolean }): React.JSX.Element {
  if (item.type === 'tool')
    return <ToolCall call={item.call} result={item.result} running={running} />
  const { event } = item
  switch (event.kind) {
    case 'text':
      return (
        <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg select-text">
          <LinkedText text={event.text ?? ''} />
        </p>
      )
    case 'thinking':
      return <Thinking event={event} />
    case 'tool_result':
      return <ToolOutput event={event} />
    default:
      return (
        <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-muted">
          <Info size={12} className="mt-[3px] shrink-0" aria-hidden />
          <span className="whitespace-pre-wrap break-words select-text">{event.text}</span>
        </p>
      )
  }
}

/** Plain text with http(s) links; opening one goes through main's confirmation. */
function LinkedText({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {splitLinks(text).map((part, index) =>
        part.kind === 'link' ? (
          <a
            key={index}
            href={part.url}
            className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
            onClick={(event) => {
              event.preventDefault()
              window.open(part.url)
            }}
          >
            {part.text}
          </a>
        ) : (
          <span key={index}>{part.text}</span>
        )
      )}
    </>
  )
}

function Disclosure({
  summary,
  children,
  defaultOpen = false
}: {
  summary: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultOpen)
  const id = useId()
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={id}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left outline-none hover:bg-panel focus-visible:ring-2 focus-visible:ring-accent"
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight
          size={12}
          aria-hidden
          className={`shrink-0 text-muted transition-transform motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`}
        />
        {summary}
      </button>
      {expanded && (
        <div id={id} className="pl-5">
          {children}
        </div>
      )}
    </div>
  )
}

function ToolCall({
  call,
  result,
  running
}: {
  call: AgentEvent
  result: AgentEvent | null
  running: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const preview = firstLine(call.inputPreview)
  const state = result ? (result.isError ? 'error' : 'ok') : running ? 'pending' : 'none'
  return (
    <Disclosure
      summary={
        <>
          <Wrench size={12} className="shrink-0 text-muted" aria-hidden />
          <span className="shrink-0 font-mono text-[12px] font-medium text-fg">{call.tool}</span>
          {preview && (
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">
              {preview}
            </span>
          )}
          <span className="ml-auto shrink-0">
            {state === 'ok' && (
              <Check size={12} className="text-ok" aria-label={t('agents.toolDone')} />
            )}
            {state === 'error' && (
              <X size={12} className="text-danger" aria-label={t('agents.toolFailed')} />
            )}
            {state === 'pending' && (
              <Loader2
                size={12}
                className="text-muted motion-safe:animate-spin"
                aria-label={t('agents.toolRunning')}
              />
            )}
          </span>
        </>
      }
    >
      {call.inputPreview && (
        <>
          <div className="mt-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted">
            {t('agents.input')}
          </div>
          <pre className={`${preClass} border-border bg-panel text-fg`}>{call.inputPreview}</pre>
        </>
      )}
      {result && <ToolOutput event={result} />}
    </Disclosure>
  )
}

function ToolOutput({ event }: { event: AgentEvent }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="mt-1.5">
      <div
        className={`text-[10.5px] font-semibold uppercase tracking-wide ${event.isError ? 'text-danger' : 'text-muted'}`}
      >
        {event.isError ? t('agents.error') : t('agents.result')}
      </div>
      <pre
        className={`${preClass} ${event.isError ? 'border-danger/40 bg-danger/5 text-danger' : 'border-border bg-panel text-fg'}`}
      >
        {event.text?.trim() ? event.text : t('agents.noOutput')}
      </pre>
    </div>
  )
}

function Thinking({ event }: { event: AgentEvent }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Disclosure
      summary={
        <>
          <Brain size={12} className="shrink-0 text-muted" aria-hidden />
          <span className="text-[12px] italic text-muted">{t('agents.thinking')}</span>
        </>
      }
    >
      <p className="mt-1 whitespace-pre-wrap break-words text-[12px] italic leading-relaxed text-muted select-text">
        {event.text}
      </p>
    </Disclosure>
  )
}
