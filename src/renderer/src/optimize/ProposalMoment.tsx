import { Check, Loader2, PencilLine, Send, SkipForward } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { OptimizeDecision, OptimizeQuestion } from '@shared/types'
import { inputClass } from '../ui/styles'
import { ActionButton } from './ActionButton'
import { Disclosure } from './Disclosure'
import { friendlyFile, plainText } from './friendly'
import { useOverflowing } from './hooks'
import { proposalVariants, revealVariants } from './motionPresets'
import { OptimizeMarkdown } from './OptimizeMarkdown'
import { useOptimize } from './optimizeStore'

/**
 * The proposal Claude waits on. It takes the whole stage, springs in from the bottom and
 * leaves downward. Mount it with `key={question.id}` so every proposal starts fresh.
 */
export function ProposalMoment({
  accountId,
  question,
  number
}: {
  accountId: string
  question: OptimizeQuestion
  /** 1-based position of this proposal in the run. */
  number: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const answer = useOptimize((s) => s.answer)
  const [busy, setBusy] = useState<OptimizeDecision | null>(null)
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState('')
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const titleId = useId()
  const noteId = useId()
  const hintId = useId()
  const canSendNote = note.trim().length > 0
  const files = question.files.map((file) => friendlyFile(file, t))

  const submit = async (decision: OptimizeDecision): Promise<void> => {
    if (busy) return
    setBusy(decision)
    const ok = await answer(
      accountId,
      question.id,
      decision,
      decision === 'modify' ? note.trim() : undefined
    )
    // On success the proposal leaves with the pending question; stay usable after a failure.
    if (!ok) setBusy(null)
  }

  const openNote = (): void => {
    setEditing(true)
    requestAnimationFrame(() => noteRef.current?.focus())
  }

  const onNoteKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (canSendNote) void submit('modify')
    } else if (event.key === 'Escape') {
      // Close the note instead of the screen.
      event.preventDefault()
      event.stopPropagation()
      setEditing(false)
    }
  }

  const icon = (decision: OptimizeDecision, fallback: ReactNode): ReactNode =>
    busy === decision ? <Loader2 size={16} className="animate-spin" aria-hidden /> : fallback

  return (
    <motion.section
      aria-labelledby={titleId}
      aria-busy={busy !== null}
      variants={proposalVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="w-full max-w-2xl"
    >
      <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-accent">
        <span aria-hidden className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
        {t('optimize.proposal.counter', { number })}
      </p>
      <h2
        id={titleId}
        className="mt-3 text-[28px] font-semibold leading-tight tracking-tight text-balance"
      >
        {plainText(question.title)}
      </h2>

      {question.rationale.trim() && <Rationale markdown={question.rationale} />}

      {files.length > 0 && (
        <p
          aria-label={`${t('optimize.proposal.files')}: ${files.join(', ')}`}
          data-tooltip={question.files.join(', ')}
          className="mt-4 truncate text-[12.5px] text-muted first-letter:uppercase"
        >
          {files.join(' · ')}
        </p>
      )}

      {question.preview && (
        <Disclosure
          className="mt-5"
          label={t('optimize.proposal.showChange')}
          openLabel={t('optimize.proposal.hideChange')}
        >
          <OptimizeMarkdown>{question.preview}</OptimizeMarkdown>
        </Disclosure>
      )}

      <AnimatePresence initial={false}>
        {editing && (
          <motion.div
            key="note"
            variants={revealVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="mt-5"
          >
            <label htmlFor={noteId} className="text-[12.5px] font-medium">
              {t('optimize.proposal.noteLabel')}
            </label>
            <textarea
              ref={noteRef}
              id={noteId}
              rows={2}
              value={note}
              disabled={busy !== null}
              aria-describedby={hintId}
              placeholder={t('optimize.proposal.notePlaceholder')}
              className={`${inputClass} mt-1.5 resize-y`}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={onNoteKey}
            />
            <p id={hintId} className="mt-1 text-[11px] text-muted">
              {t('optimize.proposal.shortcut')}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-8 flex flex-wrap items-center gap-2">
        <ActionButton variant="ghost" disabled={busy !== null} onClick={() => void submit('skip')}>
          {icon('skip', <SkipForward size={16} aria-hidden />)}
          {t('optimize.proposal.skip')}
        </ActionButton>
        {editing ? (
          <ActionButton
            variant="secondary"
            disabled={busy !== null || !canSendNote}
            onClick={() => void submit('modify')}
          >
            {icon('modify', <Send size={15} aria-hidden />)}
            {t('optimize.proposal.submitNote')}
          </ActionButton>
        ) : (
          <ActionButton variant="secondary" disabled={busy !== null} onClick={openNote}>
            <PencilLine size={16} aria-hidden />
            {t('optimize.proposal.modify')}
          </ActionButton>
        )}
        <ActionButton
          variant="primary"
          className="ml-auto"
          data-autofocus
          disabled={busy !== null}
          onClick={() => void submit('apply')}
        >
          {icon('apply', <Check size={17} aria-hidden strokeWidth={2.5} />)}
          {t('optimize.proposal.apply')}
        </ActionButton>
      </div>
    </motion.section>
  )
}

/** One or two lines of plain rationale; "More" shows Claude's full Markdown in place. */
function Rationale({ markdown }: { markdown: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const clampRef = useRef<HTMLParagraphElement>(null)
  const overflowing = useOverflowing(clampRef)
  const bodyId = useId()

  return (
    <div className="mt-3">
      <p
        ref={clampRef}
        hidden={open}
        className="line-clamp-2 text-[15px] leading-relaxed text-fg/75"
      >
        {plainText(markdown)}
      </p>
      {open && (
        <div id={bodyId} className="animate-fade-up text-fg/85">
          <OptimizeMarkdown>{markdown}</OptimizeMarkdown>
        </div>
      )}
      {(overflowing || open) && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          className="no-drag mt-1 rounded text-[12.5px] font-medium text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={() => setOpen((value) => !value)}
        >
          {t(open ? 'optimize.proposal.less' : 'optimize.proposal.more')}
        </button>
      )}
    </div>
  )
}
