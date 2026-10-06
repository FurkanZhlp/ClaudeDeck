import { Check, FileText, Loader2, PencilLine, SkipForward } from 'lucide-react'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { OptimizeDecision, OptimizeQuestion } from '@shared/types'
import { Button } from '../ui/Button'
import { inputClass, sectionTitleClass } from '../ui/styles'
import { OptimizeMarkdown } from './OptimizeMarkdown'
import { useOptimize } from './optimizeStore'

/**
 * One proposal Claude waits on. Mount it with `key={question.id}` so the note and the busy
 * state start fresh for every new proposal.
 */
export function ProposalCard({
  accountId,
  question
}: {
  accountId: string
  question: OptimizeQuestion
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

  const submit = async (decision: OptimizeDecision): Promise<void> => {
    if (busy) return
    setBusy(decision)
    const ok = await answer(
      accountId,
      question.id,
      decision,
      decision === 'modify' ? note.trim() : undefined
    )
    // On success the card is replaced by the next proposal; stay usable after a failure.
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
    }
  }

  const spinner = (decision: OptimizeDecision): React.JSX.Element | null =>
    busy === decision ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null

  return (
    <section
      aria-labelledby={titleId}
      aria-busy={busy !== null}
      className="animate-fade-up rounded-xl border border-accent/40 bg-elevated p-4 shadow-sm ring-4 ring-accent/5"
    >
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-accent">
        <span aria-hidden className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
        {t('optimize.proposal.label')}
      </div>
      <h3 id={titleId} className="mt-1.5 text-[14px] font-semibold leading-snug">
        {question.title}
      </h3>
      {question.rationale && (
        <div className="mt-2 text-fg/90">
          <OptimizeMarkdown>{question.rationale}</OptimizeMarkdown>
        </div>
      )}

      {question.files.length > 0 && (
        <div className="mt-3">
          <h4 className={sectionTitleClass}>{t('optimize.proposal.files')}</h4>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {question.files.map((file) => (
              <li
                key={file}
                className="flex max-w-full items-center gap-1 rounded-md border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] text-muted"
              >
                <FileText size={11} aria-hidden className="shrink-0" />
                <span className="truncate">{file}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {question.preview && (
        <div className="mt-3">
          <h4 className={sectionTitleClass}>{t('optimize.proposal.preview')}</h4>
          <div className="mt-1.5">
            <OptimizeMarkdown>{question.preview}</OptimizeMarkdown>
          </div>
        </div>
      )}

      {editing && (
        <div className="animate-fade-up mt-4">
          <label htmlFor={noteId} className="text-[12px] font-medium">
            {t('optimize.proposal.noteLabel')}
          </label>
          <textarea
            ref={noteRef}
            id={noteId}
            rows={3}
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
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" disabled={busy !== null} onClick={() => void submit('skip')}>
          {spinner('skip') ?? <SkipForward size={14} aria-hidden />}
          {t('optimize.proposal.skip')}
        </Button>
        {editing ? (
          <Button disabled={busy !== null || !canSendNote} onClick={() => void submit('modify')}>
            {spinner('modify') ?? <PencilLine size={14} aria-hidden />}
            {t('optimize.proposal.submitNote')}
          </Button>
        ) : (
          <Button disabled={busy !== null} onClick={openNote}>
            <PencilLine size={14} aria-hidden />
            {t('optimize.proposal.modify')}
          </Button>
        )}
        <Button variant="primary" disabled={busy !== null} onClick={() => void submit('apply')}>
          {spinner('apply') ?? <Check size={14} aria-hidden />}
          {t('optimize.proposal.apply')}
        </Button>
      </div>
    </section>
  )
}
