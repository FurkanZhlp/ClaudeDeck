import { Check, ChevronLeft, FolderTree, Loader2, Minus, SquareStack, Users } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { loginPtyId } from '@shared/ipc'
import type { Account } from '@shared/types'
import { LoginFlow } from '../components/LoginDialog'
import { errorCode, useApp } from '../store'
import * as pool from '../terminal/terminalPool'
import { Button } from '../ui/Button'
import { ColorPicker } from '../ui/ColorPicker'
import { Field } from '../ui/Field'
import { ACCOUNT_COLORS, inputClass } from '../ui/styles'
import { useOnboarding } from './onboardingStore'

/** Pause on the finished sign-in so its last step is seen before moving on. */
const SIGN_IN_ADVANCE_MS = 900

const FEATURES = [
  { key: 'accounts', Icon: Users },
  { key: 'projects', Icon: FolderTree },
  { key: 'tabs', Icon: SquareStack }
] as const

export function WelcomeStep(): React.JSX.Element {
  const { t } = useTranslation()
  const next = useOnboarding((s) => s.next)
  return (
    <div>
      <ul className="space-y-4">
        {FEATURES.map(({ key, Icon }) => (
          <li key={key} className="flex gap-3">
            <span
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-bg text-accent"
            >
              <Icon size={16} />
            </span>
            <div className="min-w-0 pt-0.5">
              <div className="font-medium">{t(`onboarding.welcome.${key}.title`)}</div>
              <p className="mt-0.5 text-muted">{t(`onboarding.welcome.${key}.body`)}</p>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-6 flex justify-end">
        <Button variant="primary" data-autofocus onClick={next}>
          {t('onboarding.welcome.start')}
        </Button>
      </div>
    </div>
  )
}

export function AccountStep(): React.JSX.Element {
  const { t } = useTranslation()
  const setStep = useOnboarding((s) => s.setStep)
  const setAccount = useOnboarding((s) => s.setAccount)
  const next = useOnboarding((s) => s.next)
  const [name, setName] = useState('')
  const [color, setColor] = useState(ACCOUNT_COLORS[0])
  const [creating, setCreating] = useState(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!name.trim() || creating) return
    setCreating(true)
    try {
      const result = await window.api.accounts.create({ name: name.trim(), color })
      useApp.setState({ data: result.state })
      const app = useApp.getState()
      app.selectAccount(result.account.id)
      void app.refreshStatus(result.account.id)
      setAccount(result.account.id)
      next()
    } catch (error) {
      useApp.getState().setError(errorCode(error))
      setCreating(false)
    }
  }

  return (
    <form className="space-y-4" onSubmit={(event) => void submit(event)}>
      <Field label={t('onboarding.account.name')}>
        <input
          className={inputClass}
          value={name}
          placeholder={t('onboarding.account.namePlaceholder')}
          onChange={(event) => setName(event.target.value)}
          maxLength={60}
          data-autofocus
        />
      </Field>
      <div className="space-y-1.5">
        <span className="block text-[12px] font-medium text-muted">
          {t('onboarding.account.color')}
        </span>
        <ColorPicker value={color} onChange={setColor} label={t('onboarding.account.color')} />
      </div>
      <div className="flex items-center gap-3 rounded-lg border border-border bg-bg p-3">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-lg font-semibold text-white transition-colors"
          style={{ background: color }}
        >
          {(name.trim().charAt(0) || '?').toLocaleUpperCase()}
        </span>
        <span className={`truncate ${name.trim() ? 'text-fg' : 'text-muted'}`}>
          {name.trim() || t('onboarding.account.previewEmpty')}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 pt-2">
        <Button variant="ghost" onClick={() => setStep('welcome')}>
          <ChevronLeft size={14} />
          {t('onboarding.back')}
        </Button>
        <Button type="submit" variant="primary" disabled={!name.trim() || creating}>
          {creating && <Loader2 size={14} className="animate-spin" />}
          {creating ? t('onboarding.account.creating') : t('onboarding.account.create')}
        </Button>
      </div>
    </form>
  )
}

export function SignInStep({
  accountId,
  onClose
}: {
  accountId: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const next = useOnboarding((s) => s.next)
  const [attempt, setAttempt] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const ptyId = loginPtyId(accountId)

  useEffect(
    () => () => {
      clearTimeout(timer.current)
      pool.dispose(ptyId)
    },
    [ptyId]
  )

  const retry = (): void => {
    pool.dispose(ptyId)
    setAttempt((n) => n + 1)
  }
  const succeeded = (): void => {
    timer.current = setTimeout(next, SIGN_IN_ADVANCE_MS)
  }

  return (
    <div>
      <LoginFlow
        key={attempt}
        accountId={accountId}
        onClose={onClose}
        onRetry={retry}
        onSuccess={succeeded}
      />
      <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-[12px] text-muted">{t('onboarding.signIn.laterHint')}</p>
        <Button variant="ghost" className="shrink-0" onClick={next}>
          {t('onboarding.skip')}
        </Button>
      </div>
    </div>
  )
}

export function DoneStep({
  account,
  onClose
}: {
  account: Account
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const mode = useOnboarding((s) => s.mode)
  const steps = useOnboarding((s) => s.steps)
  const imported = useOnboarding((s) => s.imported)
  const optimized = useOnboarding((s) => s.optimized)
  const status = useApp((s) => s.statuses[account.id])
  const signedIn = typeof status === 'object' && status.loggedIn

  const importedList = imported?.map((c) => t(`onboarding.categories.${c}`)).join(', ')

  return (
    <div>
      <ul className="space-y-3">
        <SummaryRow ok={signedIn}>
          {signedIn
            ? t('onboarding.done.signedIn', {
                name: account.name,
                email: (typeof status === 'object' && status.email) || account.name
              })
            : t('onboarding.done.signedOut', { name: account.name })}
        </SummaryRow>
        {steps.includes('import') && (
          <SummaryRow ok={!!imported?.length}>
            {imported?.length
              ? t('onboarding.done.imported', { list: importedList })
              : t('onboarding.done.importSkipped')}
          </SummaryRow>
        )}
        <SummaryRow ok={optimized}>
          {optimized ? t('onboarding.done.optimized') : t('onboarding.done.optimizeSkipped')}
        </SummaryRow>
      </ul>
      <p className="mt-5 text-[12px] text-muted">{t('onboarding.done.later')}</p>
      <div className="mt-6 flex justify-end">
        <Button variant="primary" data-autofocus onClick={onClose}>
          {mode === 'firstRun' ? t('onboarding.done.open') : t('onboarding.done.finish')}
        </Button>
      </div>
    </div>
  )
}

function SummaryRow({ ok, children }: { ok: boolean; children: ReactNode }): React.JSX.Element {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className={`flex size-6 shrink-0 items-center justify-center rounded-full ${
          ok ? 'animate-pop-in bg-accent text-accent-fg' : 'border-2 border-border text-muted'
        }`}
      >
        {ok ? <Check size={14} strokeWidth={3} /> : <Minus size={12} strokeWidth={3} />}
      </span>
      <span className={`min-w-0 pt-0.5 ${ok ? 'text-fg' : 'text-muted'}`}>{children}</span>
    </li>
  )
}
