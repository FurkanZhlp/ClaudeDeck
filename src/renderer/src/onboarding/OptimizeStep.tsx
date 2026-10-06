import { Archive, ListChecks, Loader2, LogIn, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { optimizePtyId } from '@shared/ipc'
import { errorCode, useApp } from '../store'
import { TerminalView } from '../terminal/TerminalView'
import * as pool from '../terminal/terminalPool'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { useOnboarding } from './onboardingStore'

const POINTS = [
  { key: 'review', Icon: ListChecks },
  { key: 'approve', Icon: ShieldCheck },
  { key: 'backup', Icon: Archive }
] as const

type Phase = 'intro' | 'running' | 'exited'

export function OptimizeStep({ accountId }: { accountId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const next = useOnboarding((s) => s.next)
  const setOptimized = useOnboarding((s) => s.setOptimized)
  const showSignIn = useOnboarding((s) => s.showSignIn)
  const accountName = useApp((s) => s.data?.accounts.find((a) => a.id === accountId)?.name ?? '')
  const status = useApp((s) => s.statuses[accountId])
  const signedOut = typeof status === 'object' && !status.loggedIn
  const ptyId = optimizePtyId(accountId)
  const [phase, setPhase] = useState<Phase>('intro')
  const [hasOutput, setHasOutput] = useState(false)
  const [launched, setLaunched] = useState(false)
  const [exitCode, setExitCode] = useState<number | null>(null)
  // Shown inline: the global error toast sits behind the onboarding screen.
  const [failure, setFailure] = useState<string | null>(null)
  const started = useRef(false)

  // Only a session that actually started and printed something counts as optimized.
  useEffect(() => {
    if (launched && hasOutput) setOptimized()
  }, [launched, hasOutput, setOptimized])

  // Output reaches the terminal through the store's global PTY listener; here it only
  // tells the UI that Claude is up, and when the session ends.
  useEffect(() => {
    if (phase === 'intro') return
    const offData = window.api.pty.onData((id) => {
      if (id === ptyId) setHasOutput(true)
    })
    const offExit = window.api.pty.onExit((id, code) => {
      if (id !== ptyId) return
      setExitCode(code)
      setPhase('exited')
    })
    return () => {
      offData()
      offExit()
    }
  }, [phase, ptyId])

  // Leaving the step (Finish, Skip or closing the flow) ends the session.
  useEffect(
    () => () => {
      if (started.current) void window.api.pty.kill(ptyId)
      pool.dispose(ptyId)
    },
    [ptyId]
  )

  const begin = (): void => {
    pool.prepare(ptyId)
    setPhase('running')
  }

  const onReady = useCallback(
    (cols: number, rows: number) => {
      if (started.current) return
      started.current = true
      window.api.profile
        .startOptimize(accountId, cols, rows)
        .then(() => setLaunched(true))
        .catch((error) => {
          setFailure(errorCode(error))
          setExitCode(-1)
          setPhase('exited')
        })
    },
    [accountId]
  )

  if (phase === 'intro') {
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
          <Button variant="ghost" onClick={next}>
            {t('onboarding.skip')}
          </Button>
          {signedOut ? (
            <Button variant="primary" data-autofocus onClick={showSignIn}>
              <LogIn size={14} />
              {t('onboarding.steps.signIn')}
            </Button>
          ) : (
            <Button variant="primary" data-autofocus onClick={begin}>
              {t('onboarding.optimize.start')}
            </Button>
          )}
        </div>
      </div>
    )
  }

  const statusText =
    phase === 'exited'
      ? t('onboarding.optimize.exited', { code: exitCode ?? 0 })
      : hasOutput
        ? t('onboarding.optimize.running')
        : t('onboarding.optimize.starting')

  return (
    <div>
      <p className="text-muted">{t('onboarding.optimize.runningHint')}</p>
      <div
        className="relative mt-4 h-[min(26rem,55vh)] overflow-hidden rounded-md border border-border"
        aria-label={t('onboarding.optimize.terminalLabel')}
        role="group"
      >
        <TerminalView id={ptyId} onReady={onReady} />
        {!hasOutput && phase === 'running' && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center justify-center text-[#9b9a93]"
          >
            <Loader2 size={18} className="animate-spin" />
          </div>
        )}
      </div>
      {failure && (
        <div className="mt-4" role="alert">
          <Notice tone="danger">
            <p>{t(`errors.${failure}`, { defaultValue: t('errors.UNKNOWN') })}</p>
          </Notice>
        </div>
      )}
      <div className="mt-5 flex items-center justify-between gap-3">
        <p role="status" className="flex min-w-0 items-center gap-2 text-[12px] text-muted">
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${phase === 'exited' ? 'bg-muted' : 'bg-ok'}`}
          />
          <span className="truncate">{statusText}</span>
        </p>
        <Button variant="primary" className="shrink-0" onClick={next}>
          {t('onboarding.optimize.finish')}
        </Button>
      </div>
    </div>
  )
}
