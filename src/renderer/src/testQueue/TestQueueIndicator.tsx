import { FlaskConical } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TestQueueLoad } from '@shared/types'
import { useApp } from '../store'
import { groupRuns } from './queueModel'
import { TestQueuePanel } from './TestQueuePanel'
import { useTestQueue } from './testQueueStore'

/** Keeps the queue snapshot current while the main window is open. */
function useTestQueueSync(): void {
  useEffect(() => {
    const { hydrate, subscribe } = useTestQueue.getState()
    const off = subscribe()
    void hydrate()
    return off
  }, [])
}

/**
 * Sidebar strip above the usage panel: running and waiting counts, plus a load reading in
 * automatic mode. Hidden while the feature is off; a click opens the queue panel.
 */
export function TestQueueIndicator(): React.JSX.Element | null {
  useTestQueueSync()
  const { t } = useTranslation()
  const enabled = useApp((s) => s.data?.settings.testQueue.enabled ?? false)
  const snapshot = useTestQueue((s) => s.snapshot)
  const ref = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  if (!enabled || !snapshot) return null
  const { running, waiting } = groupRuns(snapshot)
  const idle = running.length + waiting.length === 0
  const summary = idle
    ? t('testQueue.idle')
    : [
        t('testQueue.runningCount', { running: running.length, limit: snapshot.limit }),
        waiting.length > 0 ? t('testQueue.waitingCount', { count: waiting.length }) : null
      ]
        .filter(Boolean)
        .join(' · ')
  const load = snapshot.mode === 'auto' ? snapshot.load : null

  return (
    <section
      ref={ref}
      aria-label={t('testQueue.title')}
      className="relative border-t border-border"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? 'test-queue-panel' : undefined}
        className={`no-drag block w-full space-y-1 px-3 py-2 text-left text-[12px] transition-colors hover:bg-fg/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${open ? 'bg-fg/[0.05]' : ''}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <FlaskConical
            size={13}
            aria-hidden
            className={`shrink-0 ${waiting.length > 0 ? 'text-warn' : running.length > 0 ? 'text-ok' : 'text-muted'}`}
          />
          <span className={`min-w-0 flex-1 truncate ${idle ? 'text-muted' : ''}`}>{summary}</span>
        </span>
        {load && <LoadReading load={load} />}
      </button>
      <TestQueuePanel open={open} anchorRef={ref} onClose={close} />
    </section>
  )
}

/** Two tiny bars: CPU busy and memory in use; warn colours when admission is held back. */
function LoadReading({ load }: { load: TestQueueLoad }): React.JSX.Element {
  const { t } = useTranslation()
  const cpu = Math.round(load.cpuPercent)
  const memUsed = Math.round(100 - load.availableMemoryPercent)
  const tooltip = t('testQueue.loadTooltip', {
    cpu,
    memory: Math.round(load.availableMemoryPercent)
  })

  return (
    <span className="flex items-center gap-3 pl-[21px]" data-tooltip={tooltip}>
      <span className="sr-only">{tooltip}</span>
      <Bar percent={cpu} hot={load.saturated} label="CPU" />
      <Bar percent={memUsed} hot={load.lowMemory} label="RAM" />
    </span>
  )
}

function Bar({
  percent,
  hot,
  label
}: {
  percent: number
  hot: boolean
  label: string
}): React.JSX.Element {
  return (
    <span aria-hidden className="flex items-center gap-1 text-[10px] font-medium text-muted">
      {label}
      <span className="relative h-1 w-10 overflow-hidden rounded-full bg-fg/10">
        <span
          className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 motion-reduce:transition-none ${hot ? 'bg-warn' : 'bg-accent'}`}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </span>
      <span className={`tabular-nums ${hot ? 'text-warn' : ''}`}>{percent}%</span>
    </span>
  )
}
