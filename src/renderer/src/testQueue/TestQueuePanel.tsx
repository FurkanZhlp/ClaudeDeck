import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowUp, Bot, Play, Square, Unlock, X } from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { TestRun } from '@shared/types'
import { useApp } from '../store'
import { sectionTitleClass } from '../ui/styles'
import { elapsedParts, groupRuns } from './queueModel'
import { useTestQueue, type RunAction } from './testQueueStore'

const WIDTH = 400
const GAP = 8
/** Keeps the popover clear of the title bar. */
const TOP_MARGIN = 44
/** Below this much room above the strip the popover opens to the right of the sidebar. */
const MIN_ABOVE = 320

const EASE_OUT = [0.22, 1, 0.36, 1] as const

interface Props {
  open: boolean
  /** The indicator strip; clicks on it do not count as outside. */
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
}

/** Test queue popover anchored to the sidebar indicator (same behaviour as usage details). */
export function TestQueuePanel({ open, anchorRef, onClose }: Props): React.JSX.Element {
  return createPortal(
    <AnimatePresence>
      {open && <Popover key="test-queue" anchorRef={anchorRef} onClose={onClose} />}
    </AnimatePresence>,
    document.body
  )
}

function place(anchor: DOMRect): CSSProperties {
  const { innerWidth, innerHeight } = window
  const maxHeight = innerHeight - 80
  const above = anchor.top - GAP - TOP_MARGIN
  const left = above >= Math.min(MIN_ABOVE, maxHeight) ? anchor.left + GAP : anchor.right + GAP
  const bottom =
    above >= Math.min(MIN_ABOVE, maxHeight)
      ? innerHeight - anchor.top + GAP
      : Math.max(GAP, innerHeight - anchor.bottom)
  return {
    left,
    bottom,
    width: Math.min(WIDTH, innerWidth - left - GAP),
    maxHeight: Math.min(Math.max(above, MIN_ABOVE), maxHeight)
  }
}

function Popover({ anchorRef, onClose }: Omit<Props, 'open'>): React.JSX.Element {
  const { t } = useTranslation()
  const reduced = useReducedMotion() ?? false
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    const update = (): void => {
      const anchor = anchorRef.current
      if (anchor) setStyle(place(anchor.getBoundingClientRect()))
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [anchorRef])

  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // A full-window screen (sign-in, onboarding) above handles its own keys.
      if (event.key !== 'Escape' || document.querySelector('[data-screen]')) return
      event.preventDefault()
      onClose()
      anchorRef.current?.querySelector<HTMLElement>('[aria-expanded]')?.focus()
    }
    const onPointer = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (!target || ref.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer, true)
    }
  }, [anchorRef, onClose])

  return (
    <motion.div
      ref={ref}
      id="test-queue-panel"
      role="dialog"
      aria-label={t('testQueue.title')}
      tabIndex={-1}
      className="no-drag fixed z-[60] flex flex-col overflow-hidden rounded-2xl border border-border bg-elevated text-fg shadow-2xl outline-none"
      style={{
        ...(style ?? { left: 0, bottom: 0, width: WIDTH, visibility: 'hidden' }),
        transformOrigin: 'bottom left'
      }}
      initial={{ opacity: 0, scale: reduced ? 1 : 0.95, y: reduced ? 0 : 8 }}
      animate={{
        opacity: 1,
        scale: 1,
        y: 0,
        transition: reduced ? { duration: 0.12 } : { duration: 0.24, ease: EASE_OUT }
      }}
      exit={{
        opacity: 0,
        scale: reduced ? 1 : 0.97,
        y: reduced ? 0 : 6,
        transition: { duration: reduced ? 0.1 : 0.16 }
      }}
    >
      <QueueContent />
    </motion.div>
  )
}

function QueueContent(): React.JSX.Element {
  const { t } = useTranslation()
  const snapshot = useTestQueue((s) => s.snapshot)
  const { running, waiting } = groupRuns(snapshot)
  const modeLabel = snapshot
    ? t(`testQueue.mode.${snapshot.mode}`) + ' · ' + t('testQueue.limit', { count: snapshot.limit })
    : ''

  return (
    <>
      <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-[13px] font-semibold">{t('testQueue.title')}</h2>
        <span className="truncate text-[11px] text-muted">{modeLabel}</span>
      </header>
      <div className="scroll-area min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <Group
          title={t('testQueue.running')}
          count={running.length}
          empty={t('testQueue.noRunning')}
        >
          {running.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </Group>
        <Group
          title={t('testQueue.waiting')}
          count={waiting.length}
          empty={t('testQueue.noWaiting')}
        >
          {waiting.map((run, index) => (
            <RunRow key={run.id} run={run} position={index} />
          ))}
        </Group>
      </div>
    </>
  )
}

function Group({
  title,
  count,
  empty,
  children
}: {
  title: string
  count: number
  empty: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-2">
      <h3 className={`${sectionTitleClass} flex items-center gap-1.5 px-2 pb-1 pt-1`}>
        {title}
        <span className="rounded-full bg-fg/[0.08] px-1.5 text-[10px] tabular-nums">{count}</span>
      </h3>
      {count === 0 ? (
        <p className="px-2 pb-1 text-[12px] text-muted">{empty}</p>
      ) : (
        <ul className="space-y-1">{children}</ul>
      )}
    </section>
  )
}

/** "3 dk 10 sn" style duration. */
function formatElapsed(ms: number, t: TFunction): string {
  return elapsedParts(ms)
    .map(([count, unit]) => t(`testQueue.unit.${unit}`, { count }))
    .join(' ')
}

/** One run: where it comes from, the command, how long it waited or ran, and its actions. */
function RunRow({ run, position }: { run: TestRun; position?: number }): React.JSX.Element {
  const { t } = useTranslation()
  const now = useTestQueue((s) => s.now)
  const project = useApp((s) => s.data?.projects.find((p) => p.id === run.projectId))
  const tab = useApp((s) => s.data?.sessions.find((x) => x.id === run.sessionId))
  const account = useApp((s) => s.data?.accounts.find((a) => a.id === run.accountId))
  const waiting = position !== undefined
  const since = waiting ? run.enqueuedAt : (run.startedAt ?? run.enqueuedAt)
  const time = t(waiting ? 'testQueue.waitedFor' : 'testQueue.ranFor', {
    time: formatElapsed(now - since, t)
  })
  const stateLabel = !waiting && run.state !== 'running' ? t(`testQueue.state.${run.state}`) : null

  return (
    <li className="rounded-lg px-2 py-1.5 hover:bg-fg/[0.04]">
      <div className="flex items-center gap-1.5 text-[11px] text-muted">
        {waiting && (
          <span className="tabular-nums font-semibold text-fg">{(position ?? 0) + 1}.</span>
        )}
        {account && (
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: account.color }}
          />
        )}
        <span className="min-w-0 truncate">
          {[project?.name ?? t('testQueue.unknownProject'), tab?.title].filter(Boolean).join(' · ')}
        </span>
        {run.agentType && (
          <span className="flex shrink-0 items-center gap-0.5 rounded bg-fg/[0.07] px-1 text-[10px]">
            <Bot size={10} aria-hidden />
            {run.agentType}
          </span>
        )}
        {run.forced && (
          <span className="shrink-0 rounded bg-warn/15 px-1 text-[10px] text-warn">
            {t('testQueue.forced')}
          </span>
        )}
        {stateLabel && (
          <span className="shrink-0 rounded bg-fg/[0.07] px-1 text-[10px]">{stateLabel}</span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate font-mono text-[12px]"
          tabIndex={0}
          data-tooltip={run.command}
        >
          {run.command}
        </code>
        <RunActions run={run} position={position} />
      </div>
      <div className="mt-0.5 text-[11px] tabular-nums text-muted">{time}</div>
    </li>
  )
}

function RunActions({ run, position }: { run: TestRun; position?: number }): React.JSX.Element {
  const { t } = useTranslation()
  const act = useTestQueue((s) => s.act)
  const move = useTestQueue((s) => s.move)
  const [busy, setBusy] = useState(false)
  const call = (fn: () => Promise<void>): void => {
    setBusy(true)
    void fn().finally(() => setBusy(false))
  }
  const action = (name: RunAction) => () => call(() => act(name, run.id))

  if (position !== undefined) {
    return (
      <span className="flex shrink-0 items-center">
        <IconAction
          label={t('testQueue.actions.moveUp')}
          disabled={busy || position === 0}
          onClick={() => call(() => move(run.id, position - 1))}
        >
          <ArrowUp size={13} />
        </IconAction>
        <IconAction
          label={t('testQueue.actions.runNow')}
          disabled={busy}
          onClick={action('runNow')}
        >
          <Play size={13} />
        </IconAction>
        <IconAction
          label={t('testQueue.actions.cancel')}
          disabled={busy}
          danger
          onClick={action('cancel')}
        >
          <X size={13} />
        </IconAction>
      </span>
    )
  }
  return (
    <span className="flex shrink-0 items-center">
      {run.canStop ? (
        <IconAction
          label={t('testQueue.actions.stop')}
          disabled={busy}
          danger
          onClick={action('stop')}
        >
          <Square size={12} />
        </IconAction>
      ) : (
        <IconAction
          label={t('testQueue.actions.release')}
          hint={t('testQueue.actions.releaseHint')}
          disabled={busy}
          onClick={action('release')}
        >
          <Unlock size={13} />
        </IconAction>
      )}
    </span>
  )
}

function IconAction({
  label,
  hint,
  disabled,
  danger,
  onClick,
  children
}: {
  label: string
  hint?: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      data-tooltip={hint ? `${label}: ${hint}` : label}
      disabled={disabled}
      className={`rounded-md p-1.5 text-muted transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-35 enabled:hover:bg-fg/[0.08] ${danger ? 'enabled:hover:text-danger' : 'enabled:hover:text-fg'}`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
