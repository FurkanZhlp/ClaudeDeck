import { CircleAlert, CircleHelp, MessageSquareText, Send } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ASSISTANT_LIMITS, type AssistantApplyResult } from '@shared/assistant'
import type { GuardCategoryId } from '@shared/types'
import { AllowConfirmDialog } from '../guard/settings/AllowConfirmDialog'
import { useHeld } from '../optimize/hooks'
import { lineVariants, momentVariants } from '../optimize/motionPresets'
import '../optimize/optimize.css'
import { BypassConfirmDialog } from '../permissions/BypassConfirmDialog'
import type { SettingsSectionId } from '../settings/sectionIds'
import i18n from '../i18n'
import { useApp } from '../store'
import { AccountDot } from '../ui/AccountDot'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'
import { inputClass } from '../ui/styles'
import { defaultAccountId, readLastAccount, suggestionKeys } from './assistantModel'
import { useAssistant } from './assistantStore'
import { AssistantProposalView } from './AssistantProposalView'
import './assistant.css'

/** Minimum time a status line stays before the next one replaces it (as in optimize). */
const LINE_HOLD_MS = 1200

const textareaClass = `${inputClass} min-h-[84px] resize-y leading-relaxed`

/** Cmd/Ctrl+Enter sends a multi-line field. */
const sendOnModEnter =
  (send: () => void) =>
  (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      send()
    }
  }

/** "Edit settings with Claude": mounted by the settings view; shown while open. */
export function AssistantDialog(): React.JSX.Element | null {
  const open = useAssistant((s) => s.open)
  return open ? <AssistantWindow /> : null
}

function AssistantWindow(): React.JSX.Element {
  const { t } = useTranslation()
  const view = useAssistant((s) => s.view)
  const close = useAssistant((s) => s.closeWindow)

  useEffect(() => useAssistant.getState().subscribe(), [])

  return (
    <Modal
      title={t(view.step === 'compose' ? 'assistant.title' : 'assistant.windowTitle')}
      onClose={close}
      width="max-w-xl"
      closeOnBackdrop={false}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={view.step}
          variants={momentVariants}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          {view.step === 'compose' && <ComposeStep />}
          {view.step === 'working' && <WorkingStep phase={view.phase} />}
          {view.step === 'question' && <QuestionStep text={view.question.text} />}
          {view.step === 'proposal' && <ProposalStep />}
          {view.step === 'answered' && <AnsweredStep message={view.message} />}
          {view.step === 'error' && <ErrorStep code={view.code} detail={view.detail} />}
        </motion.div>
      </AnimatePresence>
    </Modal>
  )
}

function ComposeStep(): React.JSX.Element {
  const { t } = useTranslation()
  const promptId = useId()
  const privacyId = useId()
  const accountId_ = useId()
  const section = useAssistant((s) => s.section)
  const hintKey = useAssistant((s) => s.hintKey)
  const prompt = useAssistant((s) => s.prompt)
  const setPrompt = useAssistant((s) => s.setPrompt)
  const start = useAssistant((s) => s.start)
  const busy = useAssistant((s) => s.busy)
  const close = useAssistant((s) => s.closeWindow)
  const accounts = useApp((s) => s.data?.accounts) ?? []
  const projects = useApp((s) => s.data?.projects) ?? []
  const selectedProjectId = useApp((s) => s.selectedProjectId)
  const selectedAccountId = useApp((s) => s.selectedAccountId)
  const project = projects.find((p) => p.id === selectedProjectId)
  const initial = useMemo(
    () => defaultAccountId(accounts, readLastAccount(), project, selectedAccountId),
    // Chosen once when the window opens; the select keeps the user's choice afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  const [accountId, setAccountId] = useState<string | null>(initial)
  const account = accounts.find((a) => a.id === accountId)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const text = prompt.trim()
  const canSend = !!text && !!account && !busy && text.length <= ASSISTANT_LIMITS.prompt

  const send = (): void => {
    if (canSend && account) void start(text, account.id, project?.id)
  }

  return (
    <div className="space-y-3">
      <label htmlFor={promptId} className="sr-only">
        {t('assistant.promptLabel')}
      </label>
      <textarea
        id={promptId}
        ref={textRef}
        autoFocus
        rows={3}
        maxLength={ASSISTANT_LIMITS.prompt}
        value={prompt}
        placeholder={t(hintKey ?? 'assistant.placeholder')}
        aria-describedby={privacyId}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={sendOnModEnter(send)}
        className={textareaClass}
      />
      <div
        role="group"
        aria-label={t('assistant.suggestionsLabel')}
        className="flex flex-wrap gap-1.5"
      >
        {suggestionKeys(section).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setPrompt(t(key))
              textRef.current?.focus()
            }}
            className="rounded-full border border-border bg-bg px-2.5 py-1 text-[12px] text-muted transition-colors hover:border-accent/50 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent motion-reduce:transition-none"
          >
            {t(key)}
          </button>
        ))}
      </div>

      {accounts.length === 0 ? (
        <p className="text-[12px] text-warn">{t('assistant.noAccounts')}</p>
      ) : (
        <div className="flex items-center gap-2">
          <label htmlFor={accountId_} className="text-[12px] text-muted">
            {t('assistant.account')}
          </label>
          {account && <AccountDot color={account.color} />}
          <select
            id={accountId_}
            value={accountId ?? ''}
            onChange={(event) => setAccountId(event.target.value)}
            className={`${inputClass} !w-auto !py-1 text-[12px]`}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <p id={privacyId} className="text-[12px] leading-snug text-muted">
        {t('assistant.privacy')}
      </p>

      <div className="flex justify-end gap-2 pt-1">
        <Button onClick={close}>{t('common.cancel')}</Button>
        <Button
          variant="primary"
          disabled={!canSend}
          onClick={send}
          aria-keyshortcuts="Meta+Enter Control+Enter"
        >
          <MessageSquareText size={14} aria-hidden />
          {t('assistant.send')}
        </Button>
      </div>
    </div>
  )
}

function WorkingStep({ phase }: { phase: string }): React.JSX.Element {
  const { t } = useTranslation()
  const close = useAssistant((s) => s.closeWindow)
  const line = useHeld(t(`assistant.phase.${phase}`), LINE_HOLD_MS)
  return (
    <div className="flex flex-col items-center py-4 text-center">
      <div className="assistant-orb optimize-orb" aria-hidden>
        <span className="optimize-orb-halo" />
        <span className="optimize-orb-arc" />
        <span className="optimize-orb-core" />
      </div>
      <p className="mt-5 text-[15px] font-semibold tracking-tight">{t('assistant.working')}</p>
      <div role="status" aria-live="polite" className="mt-1 flex h-6 w-full justify-center">
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={line}
            variants={lineVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="max-w-full truncate text-[13px] text-muted"
          >
            {line}
          </motion.p>
        </AnimatePresence>
      </div>
      <Button className="mt-5" onClick={close}>
        {t('assistant.stop')}
      </Button>
    </div>
  )
}

/** A short reply field (answer, follow-up) with its send button. */
function ReplyField({
  label,
  placeholder,
  sendLabel,
  autoFocus
}: {
  label: string
  placeholder?: string
  sendLabel: string
  autoFocus?: boolean
}): React.JSX.Element {
  const id = useId()
  const [text, setText] = useState('')
  const followUp = useAssistant((s) => s.followUp)
  const busy = useAssistant((s) => s.busy)
  const value = text.trim()
  const canSend = !!value && !busy
  const send = (): void => {
    if (canSend) void followUp(value)
  }
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-[12px] font-medium text-muted">
        {label}
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id={id}
          rows={1}
          autoFocus={autoFocus}
          maxLength={ASSISTANT_LIMITS.followUp}
          value={text}
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={sendOnModEnter(send)}
          className={`${inputClass} min-h-[34px] resize-y`}
        />
        <Button disabled={!canSend} onClick={send} aria-label={sendLabel} data-tooltip={sendLabel}>
          <Send size={14} aria-hidden />
        </Button>
      </div>
    </div>
  )
}

function QuestionStep({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation()
  const close = useAssistant((s) => s.closeWindow)
  return (
    <div className="space-y-4">
      <div className="flex gap-2.5">
        <CircleHelp size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />
        <div>
          <p className="text-[12px] font-medium text-muted">{t('assistant.question.title')}</p>
          <p className="mt-0.5 whitespace-pre-wrap leading-relaxed">{text}</p>
        </div>
      </div>
      <ReplyField
        label={t('assistant.question.answer')}
        sendLabel={t('assistant.question.send')}
        autoFocus
      />
      <div className="flex justify-end">
        <Button onClick={close}>{t('common.cancel')}</Button>
      </div>
    </div>
  )
}

function ProposalStep(): React.JSX.Element | null {
  const { t } = useTranslation()
  const view = useAssistant((s) => s.view)
  const apply = useAssistant((s) => s.apply)
  const reject = useAssistant((s) => s.reject)
  const busy = useAssistant((s) => s.busy)
  const [confirming, setConfirming] = useState<{ queue: string[]; accepted: string[] } | null>(null)
  if (view.step !== 'proposal') return null
  const { proposal } = view

  const finish = async (accepted: string[]): Promise<void> => {
    setConfirming(null)
    const result = await apply(accepted)
    if (result) afterApply(result)
  }

  const accept = (): void => {
    if (!confirming) return
    const [current, ...rest] = confirming.queue
    const accepted = [...confirming.accepted, current]
    if (rest.length === 0) void finish(accepted)
    else setConfirming({ queue: rest, accepted })
  }

  const onApply = (): void => {
    if (busy) return
    if (proposal.confirmations.length === 0) void finish([])
    else setConfirming({ queue: [...proposal.confirmations], accepted: [] })
  }

  const current = confirming?.queue[0]
  return (
    <div className="space-y-4">
      <AssistantProposalView proposal={proposal} />
      <ReplyField
        label={t('assistant.proposal.followUp')}
        placeholder={t('assistant.proposal.followUpPlaceholder')}
        sendLabel={t('assistant.proposal.followUpSend')}
      />
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={() => void reject()}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={onApply} autoFocus>
          {t('assistant.proposal.apply')}
        </Button>
      </div>
      {current === 'bypass' && (
        <BypassConfirmDialog onCancel={() => setConfirming(null)} onAccept={accept} />
      )}
      {current?.startsWith('guardAllow:') && (
        <AllowConfirmDialog
          category={current.slice('guardAllow:'.length) as GuardCategoryId}
          onCancel={() => setConfirming(null)}
          onAccept={accept}
        />
      )}
    </div>
  )
}

/** After an apply: go to the changed section, flash its rows and offer undo. */
function afterApply(result: AssistantApplyResult): void {
  const app = useApp.getState()
  const assistant = useAssistant.getState()
  app.openSettings(result.section as SettingsSectionId)
  assistant.flash(result.keys)
  const t = (key: string): string => i18n.t(key)
  app.setNotice({
    message: t('assistant.applied'),
    action: {
      label: t('assistant.undo'),
      run: () =>
        void assistant.undo(result.undoToken).then((ok) => {
          useApp.getState().setNotice(t(ok ? 'assistant.undone' : 'assistant.undoFailed'))
          if (ok) assistant.flash(result.keys)
        })
    }
  })
}

function AnsweredStep({ message }: { message: string | null }): React.JSX.Element {
  const { t } = useTranslation()
  const close = useAssistant((s) => s.closeWindow)
  return (
    <div className="space-y-4">
      <div>
        <p className="text-[12px] font-medium text-muted">{t('assistant.answered.title')}</p>
        <p className="mt-1 whitespace-pre-wrap leading-relaxed">
          {message ?? t('assistant.answered.empty')}
        </p>
      </div>
      <ReplyField
        label={t('assistant.answered.followUp')}
        sendLabel={t('assistant.proposal.followUpSend')}
        autoFocus
      />
      <div className="flex justify-end">
        <Button onClick={close}>{t('common.close')}</Button>
      </div>
    </div>
  )
}

function ErrorStep({ code, detail }: { code: string; detail: string | null }): React.JSX.Element {
  const { t } = useTranslation()
  const retry = useAssistant((s) => s.retry)
  const close = useAssistant((s) => s.closeWindow)
  const own = code === 'TIMEOUT' || code === 'FAILED'
  return (
    <div className="space-y-4">
      <div role="alert" className="flex gap-2.5">
        <CircleAlert size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden />
        <p className="leading-relaxed">
          {own
            ? t(`assistant.error.${code}`)
            : t(`errors.${code}`, { defaultValue: t('errors.UNKNOWN') })}
        </p>
      </div>
      {detail && (
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-[12px] text-muted">
            {t('assistant.error.details')}
          </summary>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono text-[11px] text-muted">
            {detail}
          </pre>
        </details>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={close}>{t('common.close')}</Button>
        <Button variant="primary" onClick={retry} autoFocus>
          {t('assistant.error.retry')}
        </Button>
      </div>
    </div>
  )
}
