import { CheckCircle2, ChevronDown, CircleAlert, Search } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OptimizeDecision } from '@shared/types'
import { sectionTitleClass } from '../ui/styles'
import { OptimizeMarkdown } from './OptimizeMarkdown'
import type { ActivityEvent, AnsweredQuestion, FindingsEvent } from './runEvents'

const cardClass = 'animate-fade-up rounded-xl border border-border bg-bg p-4'

export function FindingsCard({ findings }: { findings: FindingsEvent }): React.JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className={cardClass}>
      <h3 id={titleId} className="flex items-center gap-2 font-semibold">
        <Search size={14} aria-hidden className="text-accent" />
        {t('optimize.findings.title')}
      </h3>
      {findings.summary && (
        <div className="mt-2">
          <OptimizeMarkdown>{findings.summary}</OptimizeMarkdown>
        </div>
      )}
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <FindingList
          title={t('optimize.findings.strengths')}
          items={findings.strengths}
          icon={<CheckCircle2 size={13} aria-hidden className="mt-0.5 shrink-0 text-ok" />}
        />
        <FindingList
          title={t('optimize.findings.issues')}
          items={findings.issues}
          icon={<CircleAlert size={13} aria-hidden className="mt-0.5 shrink-0 text-warn" />}
        />
      </div>
    </section>
  )
}

function FindingList({
  title,
  items,
  icon
}: {
  title: string
  items: string[]
  icon: React.JSX.Element
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="min-w-0">
      <h4 className={sectionTitleClass}>{title}</h4>
      <ul className="mt-1.5 space-y-1.5">
        {items.map((item, index) => (
          <li key={index} className="flex gap-2 text-[12.5px] leading-snug">
            {icon}
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const DECISION_STYLE: Record<OptimizeDecision, string> = {
  apply: 'bg-ok/12 text-ok',
  skip: 'bg-panel text-muted',
  modify: 'bg-accent/12 text-accent'
}

export function AnswerHistory({ items }: { items: AnsweredQuestion[] }): React.JSX.Element | null {
  const { t } = useTranslation()
  const titleId = useId()
  if (items.length === 0) return null
  return (
    <section aria-labelledby={titleId}>
      <h3 id={titleId} className={sectionTitleClass}>
        {t('optimize.history.title')}
      </h3>
      <ol className="mt-1.5 divide-y divide-border rounded-lg border border-border bg-bg">
        {items.map(({ question, decision, note }) => (
          <li key={question.id} className="animate-fade-up flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px]">{question.title}</div>
              {note && <div className="truncate text-[11px] text-muted">{note}</div>}
            </div>
            <span
              className={`animate-pop-in shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${DECISION_STYLE[decision]}`}
            >
              {t(`optimize.history.decision.${decision}`)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function ActivityList({ items }: { items: ActivityEvent[] }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const listId = useId()
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        className="no-drag flex items-center gap-1 rounded text-[12px] text-muted hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown
          size={13}
          aria-hidden
          className={`transition-transform ${open ? '' : '-rotate-90'}`}
        />
        {t('optimize.activity.title')}
        {items.length > 0 && <span className="tabular-nums">({items.length})</span>}
      </button>
      {open && (
        <div id={listId} className="animate-fade-up mt-2">
          {items.length === 0 ? (
            <p className="text-[12px] text-muted">{t('optimize.activity.empty')}</p>
          ) : (
            <ul className="max-h-52 overflow-y-auto rounded-lg border border-border bg-bg py-1">
              {items.map((item, index) => (
                <li
                  key={`${item.at}-${index}`}
                  className="flex items-baseline gap-3 px-3 py-0.5 text-[11.5px]"
                >
                  <span className="w-14 shrink-0 truncate text-muted">{item.tool}</span>
                  <span className="min-w-0 truncate font-mono text-fg/85" title={item.target}>
                    {item.target ?? ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
