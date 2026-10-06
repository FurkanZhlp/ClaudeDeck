import { Archive, ListChecks, Loader2, LogIn, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { useBusy } from './hooks'
import { useOptimize, useOptimizeRun } from './optimizeStore'
import { RunScreen } from './RunScreen'
import './optimize.css'

const POINTS = [
  { key: 'review', Icon: ListChecks },
  { key: 'approve', Icon: ShieldCheck },
  { key: 'backup', Icon: Archive }
] as const

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

  // A started run takes the whole window; the start screen stays in the onboarding card.
  if (run && run.status !== 'idle') return <RunScreen run={run} onDone={onDone} onSkip={onSkip} />

  return (
    <div>
      <IdlePanel accountId={accountId} onSkip={onSkip} onSignIn={onSignIn} />
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
