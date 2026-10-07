import { Loader2, Square, X } from 'lucide-react'
import { AnimatePresence, MotionConfig } from 'motion/react'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { OptimizeState } from '@shared/types'
import { linkButtonClass } from './Disclosure'
import { findingLines } from './friendly'
import { useBusy, useNow, useSequence } from './hooks'
import { FindingsMoment, ThinkingMoment } from './Moments'
import { EXIT_S } from './motionPresets'
import { isLive, useOptimize } from './optimizeStore'
import { ProgressPips } from './ProgressPips'
import { ProposalMoment } from './ProposalMoment'
import { EndedMoment, FinishedMoment } from './RunResult'
import { formatElapsed, summarize } from './runEvents'

/** How long each finding line stays on screen. */
const FINDING_STEP_MS = 2500
/** Focus moves into a new moment once the previous one has left. */
const FOCUS_DELAY_MS = EXIT_S * 1000 + 60

interface Props {
  run: OptimizeState
  onDone?: () => void
  /** Leaves the screen while the run continues in the background. */
  onSkip?: () => void
}

/**
 * Full-window run screen. Exactly one moment is on screen at a time: thinking, the findings
 * one line after another, a proposal, or the result. Moments replace each other in place.
 */
export function RunScreen({ run, onDone, onSkip }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const summary = useMemo(() => summarize(run.events), [run.events])
  const failure = useOptimize((s) => s.errors[run.accountId] ?? null)
  const mainRef = useRef<HTMLElement>(null)
  const live = isLive(run.status)

  const lines = useMemo(
    () => (summary.findings ? findingLines(summary.findings, t) : []),
    [summary.findings, t]
  )
  // Findings play once; a view reopened after answers were given skips them.
  const sequenceKey = summary.findings && summary.answered.length === 0 ? summary.findings.at : null
  const [findingIndex, skipFindings] = useSequence(sequenceKey, lines.length, FINDING_STEP_MS, live)

  let key: string
  let moment: ReactNode
  if (run.status === 'finished') {
    key = 'finished'
    moment = <FinishedMoment run={run} summary={summary} onDone={onDone} />
  } else if (!live) {
    key = 'ended'
    moment = <EndedMoment run={run} summary={summary} />
  } else if (findingIndex !== null) {
    key = 'findings'
    moment = <FindingsMoment lines={lines} index={findingIndex} stepMs={FINDING_STEP_MS} />
  } else if (run.pending) {
    key = `proposal-${run.pending.id}`
    moment = (
      <ProposalMoment
        accountId={run.accountId}
        question={run.pending}
        number={summary.numbers[run.pending.id] ?? summary.answered.length + 1}
      />
    )
  } else {
    key = 'thinking'
    moment = <ThinkingMoment run={run} summary={summary} />
  }

  const close = live ? onSkip : run.status === 'finished' ? (onDone ?? onSkip) : (onSkip ?? onDone)

  // Escape leaves the screen (inner controls such as the note field handle it first).
  useEffect(() => {
    if (!close) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  // Keyboard focus follows the moment: its main action, otherwise the stage itself.
  useEffect(() => {
    const timer = setTimeout(() => {
      const main = mainRef.current
      if (!main) return
      const target = main.querySelector<HTMLElement>('[data-autofocus]') ?? main
      target.focus({ preventScroll: true })
    }, FOCUS_DELAY_MS)
    return () => clearTimeout(timer)
  }, [key])

  return createPortal(
    <MotionConfig reducedMotion="user">
      <div
        role="dialog"
        aria-modal="true"
        data-screen
        aria-label={t('onboarding.optimize.title')}
        className="animate-screen-in fixed inset-0 z-[75] flex flex-col bg-bg"
      >
        <div className="drag flex h-11 shrink-0 items-center justify-end pl-3 pr-[calc(var(--titlebar-inset-right)_+_0.75rem)]">
          {close && (
            <button
              type="button"
              aria-label={live ? t('optimize.live.background') : t('common.close')}
              data-tooltip={live ? t('optimize.live.background') : t('common.close')}
              className="no-drag rounded-md p-1.5 text-muted hover:bg-panel hover:text-fg"
              onClick={close}
            >
              <X size={16} />
            </button>
          )}
        </div>

        <main ref={mainRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
          <div className="flex min-h-full items-center justify-center px-8 py-6">
            <AnimatePresence mode="wait" initial={false}>
              <MomentSlot key={key}>{moment}</MomentSlot>
            </AnimatePresence>
          </div>
        </main>

        <footer className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 px-6 text-[12px] text-muted">
          <span className="tabular-nums">{live && <Elapsed startedAt={run.startedAt} />}</span>
          <div className="flex min-w-0 justify-center">
            {failure ? (
              <p role="alert" className="truncate text-danger">
                {t(`errors.${failure}`, { defaultValue: t('errors.UNKNOWN') })}
              </p>
            ) : (
              live && <ProgressPips items={summary.answered} />
            )}
          </div>
          <div className="flex justify-end">
            {key === 'findings' ? (
              <button type="button" className={linkButtonClass} onClick={skipFindings}>
                {t('optimize.findings.skip')}
              </button>
            ) : (
              live && <StopButton accountId={run.accountId} />
            )}
          </div>
        </footer>
      </div>
    </MotionConfig>,
    document.body
  )
}

/** Keeps each moment a direct, keyed child of AnimatePresence. */
function MomentSlot({ children }: { children: ReactNode }): React.JSX.Element {
  return <>{children}</>
}

function Elapsed({ startedAt }: { startedAt: number | null }): React.JSX.Element | null {
  const { t } = useTranslation()
  const now = useNow(startedAt !== null)
  if (startedAt === null) return null
  return <>{t('optimize.live.elapsed', { time: formatElapsed(now - startedAt) })}</>
}

function StopButton({ accountId }: { accountId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const cancel = useOptimize((s) => s.cancel)
  const [busy, guard] = useBusy()
  const stop = (): void => {
    if (window.confirm(t('optimize.live.stopConfirm'))) guard(() => cancel(accountId))
  }
  return (
    <button type="button" disabled={busy} className={linkButtonClass} onClick={stop}>
      {busy ? (
        <Loader2 size={11} className="animate-spin" aria-hidden />
      ) : (
        <Square size={9} aria-hidden className="fill-current" />
      )}
      {t('optimize.live.stop')}
    </button>
  )
}
