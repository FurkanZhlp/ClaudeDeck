import { Check, ChevronDown, Copy, ExternalLink, Loader2, RotateCw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { loginPtyId } from '@shared/ipc'
import { parseLoginOutput, type LoginStage } from '@shared/loginProgress'
import { errorCode, useApp } from '../store'
import { TerminalView } from '../terminal/TerminalView'
import * as pool from '../terminal/terminalPool'
import { Button } from '../ui/Button'
import { inputClass } from '../ui/styles'

const STEPS = ['browser', 'signIn', 'code', 'done'] as const
type StepState = 'pending' | 'active' | 'optional' | 'done' | 'failed'

/** Output often arrives in one burst; advance one step at a time so each is visible. */
const STEP_DELAY_MS = 550
const MAX_OUTPUT = 20_000
const LOGIN_COLS = 100
const LOGIN_ROWS = 30
const CODE_STEP = STEPS.indexOf('code')

/** Index of the step in progress for a stage; STEPS.length means every step is done. */
function targetStep(stage: LoginStage): number {
  if (stage === 'waiting') return 1
  if (stage === 'success') return STEPS.length
  return 0
}

export function LoginDialog(): React.JSX.Element | null {
  const accountId = useApp((s) => s.loginAccountId)
  return accountId ? <LoginContent key={accountId} accountId={accountId} /> : null
}

function LoginContent({ accountId }: { accountId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const account = useApp((s) => s.data?.accounts.find((a) => a.id === accountId))
  const setLoginAccount = useApp((s) => s.setLoginAccount)
  const refreshStatus = useApp((s) => s.refreshStatus)
  const [attempt, setAttempt] = useState(0)
  const ptyId = loginPtyId(accountId)

  const close = useCallback(() => {
    void window.api.pty.kill(ptyId)
    pool.dispose(ptyId)
    setLoginAccount(null)
    void refreshStatus(accountId)
  }, [ptyId, accountId, setLoginAccount, refreshStatus])

  const retry = (): void => {
    pool.dispose(ptyId)
    setAttempt((n) => n + 1)
  }

  if (!account) return null
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('login.title', { name: account.name })}
      className="animate-screen-in fixed inset-0 z-[70] flex flex-col bg-bg"
    >
      <div className="drag flex h-11 shrink-0 items-center justify-end px-3">
        <button
          type="button"
          aria-label={t('common.close')}
          className="no-drag rounded-md p-1.5 text-muted hover:bg-panel hover:text-fg"
          onClick={close}
        >
          <X size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
        <div className="mx-auto flex min-h-full w-full max-w-lg flex-col justify-center py-6">
          <div className="animate-fade-up mb-8 flex flex-col items-center text-center">
            <span
              aria-hidden
              className="mb-4 flex size-14 items-center justify-center rounded-2xl text-xl font-semibold text-white shadow-lg"
              style={{ background: account.color }}
            >
              {account.name.trim().charAt(0).toLocaleUpperCase()}
            </span>
            <h1 className="text-lg font-semibold">{t('login.title', { name: account.name })}</h1>
            <p className="mt-1 text-muted">{account.email ?? t('login.subtitle')}</p>
          </div>
          <div className="rounded-2xl border border-border bg-elevated p-6 shadow-sm">
            <LoginFlow key={attempt} accountId={accountId} onClose={close} onRetry={retry} />
          </div>
        </div>
      </div>
    </div>
  )
}

interface FlowProps {
  accountId: string
  onClose: () => void
  onRetry: () => void
}

function LoginFlow({ accountId, onClose, onRetry }: FlowProps): React.JSX.Element {
  const { t } = useTranslation()
  const setError = useApp((s) => s.setError)
  const refreshStatus = useApp((s) => s.refreshStatus)
  const status = useApp((s) => s.statuses[accountId])
  const ptyId = loginPtyId(accountId)

  const [output, setOutput] = useState('')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [shown, setShown] = useState(0)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    pool.prepare(ptyId)
    const offData = window.api.pty.onData((id, data) => {
      if (id === ptyId) setOutput((prev) => (prev + data).slice(-MAX_OUTPUT))
    })
    const offExit = window.api.pty.onExit((id, code) => {
      if (id === ptyId) setExitCode(code)
    })
    window.api.pty.startLogin(accountId, LOGIN_COLS, LOGIN_ROWS).catch((error) => {
      setError(errorCode(error))
      setExitCode(-1)
    })
    return () => {
      offData()
      offExit()
      void window.api.pty.kill(ptyId)
    }
  }, [ptyId, accountId, setError])

  const progress = useMemo(() => parseLoginOutput(output, exitCode), [output, exitCode])
  const failed = progress.stage === 'failed'
  const target = targetStep(progress.stage)
  const finished = shown >= STEPS.length

  useEffect(() => {
    if (failed || shown >= target) return
    const timer = setTimeout(() => setShown((n) => n + 1), STEP_DELAY_MS)
    return () => clearTimeout(timer)
  }, [failed, shown, target])

  useEffect(() => {
    if (progress.stage === 'success') void refreshStatus(accountId)
  }, [progress.stage, accountId, refreshStatus])

  const stateOf = (index: number): StepState => {
    if (failed && index === Math.min(shown, STEPS.length - 1)) return 'failed'
    if (index < shown) return 'done'
    if (index === shown) return failed ? 'pending' : 'active'
    // The code step can be used while waiting for the browser sign-in.
    if (index === CODE_STEP && shown === CODE_STEP - 1 && !failed) return 'optional'
    return 'pending'
  }

  const openUrl = (): void => {
    if (progress.url) window.open(progress.url)
  }
  const copyUrl = (): void => {
    if (!progress.url) return
    void navigator.clipboard.writeText(progress.url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  const submitCode = (event: FormEvent): void => {
    event.preventDefault()
    if (!code.trim()) return
    window.api.pty.write(ptyId, `${code.trim()}\r`)
    setCode('')
    setCodeSent(true)
  }

  const email = typeof status === 'object' && status.loggedIn ? status.email : undefined

  const content = (index: number, state: StepState): ReactNode => {
    const step = STEPS[index]
    if (step === 'browser' && state === 'active') return <p>{t('login.steps.browserHint')}</p>
    if (step === 'signIn' && state === 'active') {
      return (
        <>
          <p>{t('login.steps.signInHint')}</p>
          {progress.url && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={openUrl}>
                <ExternalLink size={14} />
                {t('login.reopen')}
              </Button>
              <Button variant="ghost" onClick={copyUrl}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? t('login.copied') : t('login.copyLink')}
              </Button>
            </div>
          )}
        </>
      )
    }
    if (step === 'code' && (state === 'optional' || state === 'active')) {
      return (
        <>
          <p>{codeSent ? t('login.codeSent') : t('login.steps.codeHint')}</p>
          <form className="flex gap-2" onSubmit={submitCode}>
            <input
              className={`${inputClass} flex-1 font-mono`}
              value={code}
              placeholder={t('login.codePlaceholder')}
              onChange={(event) => setCode(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <Button type="submit" disabled={!code.trim()}>
              {t('login.submit')}
            </Button>
          </form>
        </>
      )
    }
    if (step === 'done' && state === 'done') {
      return <p>{email ? t('login.signedInAs', { email }) : t('login.steps.doneHint')}</p>
    }
    return null
  }

  return (
    <div>
      <ol>
        {STEPS.map((step, index) => {
          const state = stateOf(index)
          const body = content(index, state)
          return (
            <li key={step} className="relative flex gap-3 pb-5 last:pb-0">
              {index < STEPS.length - 1 && (
                <span
                  aria-hidden
                  className="absolute bottom-0 left-3 top-7 w-px -translate-x-1/2 overflow-hidden bg-border"
                >
                  <span
                    className="block w-full bg-accent transition-[height] duration-500 ease-out"
                    style={{ height: state === 'done' ? '100%' : '0%' }}
                  />
                </span>
              )}
              <StepIcon state={state} number={index + 1} />
              <div className="min-w-0 flex-1 pt-0.5">
                <div
                  className={`font-medium transition-colors ${state === 'pending' ? 'text-muted' : 'text-fg'}`}
                >
                  {t(`login.steps.${step}`)}
                </div>
                {body && (
                  <div key={state} className="animate-fade-up mt-1.5 space-y-2.5 text-muted">
                    {body}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {failed && (
        <div className="animate-fade-up mt-4 rounded-lg border border-border bg-bg p-3">
          <p className="font-medium text-danger">{t('login.failed')}</p>
          <p className="mt-1 text-muted">{t('login.failedHint')}</p>
        </div>
      )}

      {(detailsOpen || failed) && (
        <div className="animate-fade-up mt-4 h-56 overflow-hidden rounded-md border border-border">
          <TerminalView id={ptyId} />
        </div>
      )}

      <div className="mt-5 flex items-center justify-between gap-2">
        {failed ? (
          <span />
        ) : (
          <button
            type="button"
            className="flex items-center gap-1 text-[12px] text-muted hover:text-fg"
            onClick={() => setDetailsOpen((open) => !open)}
          >
            <ChevronDown
              size={14}
              className={`transition-transform ${detailsOpen ? 'rotate-180' : ''}`}
            />
            {detailsOpen ? t('login.hideDetails') : t('login.showDetails')}
          </button>
        )}
        <div className="flex gap-2">
          {failed && (
            <Button variant="primary" onClick={onRetry}>
              <RotateCw size={14} />
              {t('login.retry')}
            </Button>
          )}
          <Button variant={finished ? 'primary' : 'secondary'} onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function StepIcon({ state, number }: { state: StepState; number: number }): React.JSX.Element {
  const base =
    'relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold'
  switch (state) {
    case 'done':
      return (
        <span className={`${base} animate-pop-in bg-accent text-accent-fg`}>
          <Check size={14} strokeWidth={3} />
        </span>
      )
    case 'active':
      return (
        <span className={`${base} bg-elevated text-accent ring-2 ring-accent/30`}>
          <Loader2 size={14} className="animate-spin" />
        </span>
      )
    case 'failed':
      return (
        <span className={`${base} animate-pop-in bg-danger text-white`}>
          <X size={14} strokeWidth={3} />
        </span>
      )
    case 'optional':
      return (
        <span className={`${base} border-2 border-dashed border-accent/60 bg-elevated text-accent`}>
          {number}
        </span>
      )
    default:
      return (
        <span className={`${base} border-2 border-border bg-elevated text-muted`}>{number}</span>
      )
  }
}
