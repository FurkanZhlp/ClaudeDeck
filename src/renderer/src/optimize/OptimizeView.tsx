import {
  Archive,
  CheckCircle2,
  CircleSlash,
  ListChecks,
  Loader2,
  LogIn,
  RotateCcw,
  ShieldCheck,
  Square,
  Undo2,
  XCircle
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { OptimizeState } from '@shared/types'
import { useApp } from '../store'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { sectionTitleClass } from '../ui/styles'
import { OptimizeMarkdown } from './OptimizeMarkdown'
import { isLive, useOptimize, useOptimizeRun } from './optimizeStore'
import { ProposalCard } from './ProposalCard'
import { ActivityList, AnswerHistory, FindingsCard } from './RunDetails'
import { formatElapsed, summarize, toolKey, type LiveEvent, type RunSummary } from './runEvents'

const POINTS = [
  { key: 'review', Icon: ListChecks },
  { key: 'approve', Icon: ShieldCheck },
  { key: 'backup', Icon: Archive }
] as const

const CLOCK_TICK_MS = 1000

interface Props {
  accountId: string
  /** Called by "Done" after a finished run. */
  onDone?: () => void
  /** Leaves the view without starting, or lets a live run continue in the background. */
  onSkip?: () => void
  /** Sign-in action for a signed-out account; defaults to the app's sign-in dialog. */
  onSignIn?: () => void
}

/** Headless profile optimization: start, follow, answer proposals, review and undo. */
export function OptimizeView({ accountId, onDone, onSkip, onSignIn }: Props): React.JSX.Element {
  const run = useOptimizeRun(accountId)
  const failure = useOptimize((s) => s.errors[accountId] ?? null)

  return (
    <div>
      {!run || run.status === 'idle' ? (
        <IdlePanel accountId={accountId} onSkip={onSkip} onSignIn={onSignIn} />
      ) : (
        <RunPanel run={run} onDone={onDone} onSkip={onSkip} />
      )}
      {failure && <InlineError code={failure} />}
    </div>
  )
}

function InlineError({ code }: { code: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="animate-fade-up mt-4" role="alert">
      <Notice tone="danger">
        <p>{t(`errors.${code}`, { defaultValue: t('errors.UNKNOWN') })}</p>
      </Notice>
    </div>
  )
}

/** Runs `action` once at a time and reports whether it is in flight. */
function useBusy(): [boolean, (action: () => Promise<unknown>) => void] {
  const [busy, setBusy] = useState(false)
  const run = (action: () => Promise<unknown>): void => {
    if (busy) return
    setBusy(true)
    void action().finally(() => setBusy(false))
  }
  return [busy, run]
}

function IdlePanel({
  accountId,
  onSkip,
  onSignIn
}: Pick<Props, 'accountId' | 'onSkip' | 'onSignIn'>): React.JSX.Element {
  const { t } = useTranslation()
  const start = useOptimize((s) => s.start)
  const accountName = useApp((s) => s.data?.accounts.find((a) => a.id === accountId)?.name ?? '')
  const status = useApp((s) => s.statuses[accountId])
  const signedOut = typeof status === 'object' && !status.loggedIn
  const [busy, guard] = useBusy()
  const signIn = onSignIn ?? (() => useApp.getState().setLoginAccount(accountId))

  return (
    <div>
      <p className="text-muted">{t('onboarding.optimize.intro')}</p>
      <ul className="mt-5 space-y-4">
        {POINTS.map(({ key, Icon }) => (
          <li key={key} className="flex gap-3">
            <span
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-bg text-accent"
            >
              <Icon size={16} />
            </span>
            <div className="min-w-0 pt-0.5">
              <div className="font-medium">{t(`onboarding.optimize.points.${key}.title`)}</div>
              <p className="mt-0.5 text-muted">{t(`onboarding.optimize.points.${key}.body`)}</p>
            </div>
          </li>
        ))}
      </ul>
      {signedOut && (
        <div className="mt-5">
          <Notice tone="warn">
            <p>{t('onboarding.done.signedOut', { name: accountName })}</p>
          </Notice>
        </div>
      )}
      <div className="mt-6 flex items-center justify-end gap-2">
        {onSkip && (
          <Button variant="ghost" onClick={onSkip}>
            {t('onboarding.skip')}
          </Button>
        )}
        {signedOut ? (
          <Button variant="primary" data-autofocus onClick={signIn}>
            <LogIn size={14} />
            {t('onboarding.steps.signIn')}
          </Button>
        ) : (
          <Button
            variant="primary"
            data-autofocus
            disabled={busy}
            onClick={() => guard(() => start(accountId))}
          >
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {t('optimize.start')}
          </Button>
        )}
      </div>
    </div>
  )
}

function RunPanel({
  run,
  onDone,
  onSkip
}: {
  run: OptimizeState
  onDone?: () => void
  onSkip?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const summary = useMemo(() => summarize(run.events), [run.events])
  const live = isLive(run.status)

  return (
    <div className="space-y-4">
      {live ? (
        <LiveHeader run={run} summary={summary} />
      ) : run.status === 'finished' ? (
        <FinishedCard run={run} summary={summary} onDone={onDone} />
      ) : (
        <EndedCard run={run} summary={summary} />
      )}

      {summary.findings && <FindingsCard findings={summary.findings} />}
      <AnswerHistory items={summary.answered} />
      {live && run.pending && (
        <ProposalCard key={run.pending.id} accountId={run.accountId} question={run.pending} />
      )}
      <ActivityList items={summary.activities} />

      {live && (
        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <p className="text-[12px] text-muted">{t('optimize.live.hint')}</p>
          {onSkip && (
            <Button variant="ghost" className="shrink-0" onClick={onSkip}>
              {t('optimize.live.background')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** Re-renders every second while `active`, for the elapsed time. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function liveMessage(t: TFunction, run: OptimizeState, latest: LiveEvent | null): string {
  if (run.status === 'waiting' || run.pending) return t('optimize.live.waiting')
  if (!latest) {
    return run.status === 'starting' ? t('optimize.live.starting') : t('optimize.live.working')
  }
  if (latest.type === 'status') return latest.message
  return t(`optimize.activity.tools.${toolKey(latest.tool)}`, {
    tool: latest.tool,
    target: latest.target ?? ''
  }).trim()
}

function LiveHeader({
  run,
  summary
}: {
  run: OptimizeState
  summary: RunSummary
}): React.JSX.Element {
  const { t } = useTranslation()
  const cancel = useOptimize((s) => s.cancel)
  const now = useNow(true)
  const [busy, guard] = useBusy()
  const waiting = run.status === 'waiting' || run.pending !== null
  const message = liveMessage(t, run, summary.latest)

  const stop = (): void => {
    if (window.confirm(t('optimize.live.stopConfirm'))) guard(() => cancel(run.accountId))
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-bg px-4 py-3">
      <span
        aria-hidden
        className={`flex size-8 shrink-0 items-center justify-center rounded-full ${waiting ? 'bg-warn/12 text-warn' : 'bg-accent/10 text-accent'}`}
      >
        {waiting ? (
          <span className="size-2 rounded-full bg-warn motion-safe:animate-pulse" />
        ) : (
          <Loader2 size={16} className="animate-spin" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p role="status" aria-live="polite" className="truncate font-medium">
          <span key={message} className="animate-fade-up inline-block max-w-full truncate">
            {message}
          </span>
        </p>
        {run.startedAt !== null && (
          <p className="text-[11.5px] tabular-nums text-muted">
            {t('optimize.live.elapsed', { time: formatElapsed(now - run.startedAt) })}
          </p>
        )}
      </div>
      <Button variant="ghost" className="shrink-0" disabled={busy} onClick={stop}>
        {busy ? (
          <Loader2 size={13} className="animate-spin" aria-hidden />
        ) : (
          <Square size={12} aria-hidden />
        )}
        {t('optimize.live.stop')}
      </Button>
    </div>
  )
}

function FinishedCard({
  run,
  summary,
  onDone
}: {
  run: OptimizeState
  summary: RunSummary
  onDone?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const revert = useOptimize((s) => s.revert)
  const [busy, guard] = useBusy()
  const finish = summary.finish
  const changes = finish?.changes ?? []

  const undoAll = (): void => {
    if (window.confirm(t('optimize.finished.revertConfirm'))) guard(() => revert(run.accountId))
  }

  return (
    <section className="animate-fade-up rounded-xl border border-border bg-bg p-4">
      <h3 className="flex items-center gap-2 font-semibold">
        <CheckCircle2 size={16} aria-hidden className="animate-pop-in text-ok" />
        {t('optimize.finished.title')}
      </h3>
      {finish?.summary && (
        <div className="mt-2">
          <OptimizeMarkdown>{finish.summary}</OptimizeMarkdown>
        </div>
      )}
      <h4 className={`${sectionTitleClass} mt-3`}>{t('optimize.finished.changes')}</h4>
      {changes.length > 0 ? (
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[12.5px] marker:text-muted">
          {changes.map((change, index) => (
            <li key={index}>{change}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[12.5px] text-muted">{t('optimize.finished.noChanges')}</p>
      )}
      {run.backupDir && (
        <p className="mt-3 flex items-start gap-1.5 text-[11.5px] text-muted">
          <Archive size={12} aria-hidden className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-all select-text">
            {t('optimize.finished.backup', { path: run.backupDir })}
          </span>
        </p>
      )}
      {run.reverted && (
        <p
          role="status"
          className="animate-fade-up mt-3 flex items-center gap-1.5 text-[12.5px] text-ok"
        >
          <Undo2 size={13} aria-hidden />
          {t('optimize.finished.reverted')}
        </p>
      )}
      <div className="mt-4 flex items-center justify-end gap-2">
        {run.backupDir && !run.reverted && (
          <Button variant="ghost" disabled={busy} onClick={undoAll}>
            {busy ? (
              <Loader2 size={14} className="animate-spin" aria-hidden />
            ) : (
              <Undo2 size={14} aria-hidden />
            )}
            {t('optimize.finished.revert')}
          </Button>
        )}
        {onDone && (
          <Button variant="primary" data-autofocus onClick={onDone}>
            {t('optimize.finished.done')}
          </Button>
        )}
      </div>
    </section>
  )
}

function EndedCard({
  run,
  summary
}: {
  run: OptimizeState
  summary: RunSummary
}): React.JSX.Element {
  const { t } = useTranslation()
  const start = useOptimize((s) => s.start)
  const [busy, guard] = useBusy()
  const failed = run.status === 'failed'

  return (
    <section className="animate-fade-up rounded-xl border border-border bg-bg p-4">
      <h3 className="flex items-center gap-2 font-semibold">
        {failed ? (
          <XCircle size={16} aria-hidden className="animate-pop-in text-danger" />
        ) : (
          <CircleSlash size={16} aria-hidden className="animate-pop-in text-muted" />
        )}
        {t(failed ? 'optimize.failed.title' : 'optimize.cancelled.title')}
      </h3>
      <p className="mt-1.5 text-muted" role={failed ? 'alert' : undefined}>
        {failed ? (summary.error ?? t('optimize.failed.unknown')) : t('optimize.cancelled.body')}
      </p>
      <div className="mt-4 flex justify-end">
        <Button
          variant="primary"
          data-autofocus
          disabled={busy}
          onClick={() => guard(() => start(run.accountId))}
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" aria-hidden />
          ) : (
            <RotateCcw size={14} aria-hidden />
          )}
          {t('optimize.failed.retry')}
        </Button>
      </div>
    </section>
  )
}
