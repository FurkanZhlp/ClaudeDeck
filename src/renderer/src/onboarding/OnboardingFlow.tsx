import { Check, LayoutGrid, UserPlus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Account } from '@shared/types'
import { useApp } from '../store'
import { ImportStep } from './ImportStep'
import { useOnboarding, type OnboardingStep } from './onboardingStore'
import { OptimizeStep } from './OptimizeStep'
import { AccountStep, DoneStep, SignInStep, WelcomeStep } from './simpleSteps'

const ACCOUNT_STEPS: OnboardingStep[] = ['signIn', 'import', 'optimize', 'done']

const WIDTH: Record<OnboardingStep, string> = {
  welcome: 'max-w-lg',
  account: 'max-w-lg',
  signIn: 'max-w-lg',
  import: 'max-w-xl',
  optimize: 'max-w-3xl',
  done: 'max-w-lg'
}

/** Full-window first-run and per-account setup: sign-in, profile import and optimize. */
export function OnboardingFlow(): React.JSX.Element | null {
  const open = useOnboarding((s) => s.open)
  return open ? <OnboardingContent /> : null
}

function OnboardingContent(): React.JSX.Element | null {
  const { t } = useTranslation()
  const step = useOnboarding((s) => s.step)
  const accountId = useOnboarding((s) => s.accountId)
  const closeFlow = useOnboarding((s) => s.close)
  const account = useApp((s) => s.data?.accounts.find((a) => a.id === accountId))
  const refreshStatus = useApp((s) => s.refreshStatus)
  const bodyRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  const needsAccount = ACCOUNT_STEPS.includes(step)
  const missingAccount = needsAccount && !account

  const close = useCallback(() => {
    if (accountId) void refreshStatus(accountId)
    closeFlow()
  }, [accountId, refreshStatus, closeFlow])

  // The account was removed while the flow was open; nothing left to set up.
  useEffect(() => {
    if (missingAccount) closeFlow()
  }, [missingAccount, closeFlow])

  // Move focus into each new step: its marked control, otherwise the heading.
  useEffect(() => {
    const target =
      bodyRef.current?.querySelector<HTMLElement>('[data-autofocus]') ?? headingRef.current
    target?.focus()
  }, [step])

  if (missingAccount) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-screen
      aria-label={t('onboarding.title')}
      className="animate-screen-in fixed inset-0 z-[70] flex flex-col bg-bg"
    >
      <div className="drag flex h-11 shrink-0 items-center justify-end px-3">
        <button
          type="button"
          aria-label={t('common.close')}
          data-tooltip={t('common.close')}
          className="no-drag rounded-md p-1.5 text-muted hover:bg-panel hover:text-fg"
          onClick={close}
        >
          <X size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
        <div
          className={`mx-auto flex min-h-full w-full ${WIDTH[step]} flex-col justify-center py-6 transition-[max-width] duration-300`}
        >
          <StepIndicator />
          <div key={step} className="animate-fade-up mb-8 flex flex-col items-center text-center">
            <StepBadge step={step} account={account} />
            <h1 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
              {t(`onboarding.${step}.title`, { name: account?.name ?? '' })}
            </h1>
            <p className="mt-1 max-w-md text-muted">
              {step === 'signIn' && account?.email
                ? account.email
                : t(`onboarding.${step}.subtitle`)}
            </p>
          </div>
          <div
            ref={bodyRef}
            key={`${step}-card`}
            className="animate-fade-up rounded-2xl border border-border bg-elevated p-6 shadow-sm"
          >
            <StepBody step={step} account={account} onClose={close} />
          </div>
        </div>
      </div>
    </div>
  )
}

function StepBody({
  step,
  account,
  onClose
}: {
  step: OnboardingStep
  account: Account | undefined
  onClose: () => void
}): ReactNode {
  if (step === 'welcome') return <WelcomeStep />
  if (step === 'account') return <AccountStep />
  if (!account) return null
  switch (step) {
    case 'signIn':
      return <SignInStep accountId={account.id} onClose={onClose} />
    case 'import':
      return <ImportStep accountId={account.id} />
    case 'optimize':
      return <OptimizeStep accountId={account.id} />
    case 'done':
      return <DoneStep account={account} onClose={onClose} />
  }
}

function StepBadge({
  step,
  account
}: {
  step: OnboardingStep
  account: Account | undefined
}): React.JSX.Element {
  const base =
    'mb-4 flex size-14 items-center justify-center rounded-2xl text-xl font-semibold shadow-lg'
  if (step === 'welcome') {
    return (
      <span aria-hidden className={`${base} bg-accent text-accent-fg`}>
        <LayoutGrid size={24} />
      </span>
    )
  }
  if (step === 'account' || !account) {
    return (
      <span aria-hidden className={`${base} border border-border bg-elevated text-accent`}>
        <UserPlus size={24} />
      </span>
    )
  }
  return (
    <span aria-hidden className={`${base} text-white`} style={{ background: account.color }}>
      {account.name.trim().charAt(0).toLocaleUpperCase()}
    </span>
  )
}

function StepIndicator(): React.JSX.Element | null {
  const { t } = useTranslation()
  const steps = useOnboarding((s) => s.steps)
  const step = useOnboarding((s) => s.step)
  const current = steps.indexOf(step)
  if (steps.length < 2) return null

  return (
    <nav aria-label={t('onboarding.progress', { current: current + 1, total: steps.length })}>
      <ol className="mb-8 flex items-start justify-center">
        {steps.map((item, index) => {
          const done = index < current
          const active = index === current
          return (
            <li
              key={item}
              aria-current={active ? 'step' : undefined}
              className="relative flex w-20 flex-col items-center gap-1.5"
            >
              {index > 0 && (
                <span
                  aria-hidden
                  className="absolute right-1/2 top-3 mr-3.5 h-px w-[calc(100%-1.75rem)] overflow-hidden bg-border"
                >
                  <span
                    className="block h-full bg-accent transition-[width] duration-500 ease-out"
                    style={{ width: index <= current ? '100%' : '0%' }}
                  />
                </span>
              )}
              <span
                aria-hidden
                className={`relative z-10 flex size-6 items-center justify-center rounded-full text-[11px] font-semibold transition-colors ${
                  done
                    ? 'animate-pop-in bg-accent text-accent-fg'
                    : active
                      ? 'bg-elevated text-accent ring-2 ring-accent/40'
                      : 'border-2 border-border bg-elevated text-muted'
                }`}
              >
                {done ? <Check size={13} strokeWidth={3} /> : index + 1}
              </span>
              <span
                className={`text-[11px] transition-colors ${active ? 'font-medium text-fg' : 'text-muted'}`}
              >
                {t(`onboarding.steps.${item}`)}
              </span>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
