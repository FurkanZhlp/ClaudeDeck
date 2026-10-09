import { ArrowRight, FlaskConical, Minus, Plus, TriangleAlert } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AssistantChange,
  AssistantExample,
  AssistantOutcome,
  AssistantProposal,
  AssistantRisk
} from '@shared/assistant'
import { useApp } from '../store'
import { describeDiff, type DiffLine, type Translate } from './assistantModel'

const OUTCOME_TONE: Record<AssistantOutcome, string> = {
  allow: 'bg-ok/12 text-ok',
  ask: 'bg-warn/12 text-warn',
  deny: 'bg-danger/12 text-danger',
  queued: 'bg-accent/12 text-accent',
  notQueued: 'bg-fg/[0.06] text-muted'
}

const outcomeLabel = (outcome: AssistantOutcome, t: Translate): string =>
  outcome === 'queued' || outcome === 'notQueued'
    ? t(`assistant.proposal.${outcome}`)
    : t(`guard.actions.${outcome}`)

function OutcomeBadge({ outcome }: { outcome: AssistantOutcome }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <span
      className={`inline-flex shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${OUTCOME_TONE[outcome]}`}
    >
      {outcomeLabel(outcome, t)}
    </span>
  )
}

const codeClass = 'rounded bg-fg/[0.06] px-1 py-0.5 font-mono text-[12px] break-all'

function DiffRow({ line }: { line: DiffLine }): React.JSX.Element {
  const { t } = useTranslation()
  if (line.kind === 'set') {
    return (
      <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="min-w-0 font-medium">{line.label}</span>
        <span className="flex items-center gap-1.5 text-muted">
          <span className="line-through decoration-fg/30">{line.from}</span>
          <ArrowRight size={12} aria-label={t('assistant.proposal.becomes')} />
          <span className="font-medium text-fg">{line.to}</span>
        </span>
      </li>
    )
  }
  if (line.kind === 'rule') {
    const Icon = line.added ? Plus : Minus
    return (
      <li className="flex items-start gap-2">
        <Icon
          size={13}
          className={`mt-1 shrink-0 ${line.added ? 'text-ok' : 'text-danger'}`}
          aria-hidden
        />
        <span className="min-w-0">
          <span className="text-muted">
            {t(line.added ? 'assistant.proposal.ruleAdded' : 'assistant.proposal.ruleRemoved')}
            {line.rule.kind === 'regex' ? ` (${t('assistant.proposal.regex')})` : ''}:{' '}
          </span>
          <code className={codeClass}>{line.rule.pattern}</code>
          {line.action && <span className="ml-1.5 font-medium">{line.action}</span>}
        </span>
      </li>
    )
  }
  return (
    <li className="flex items-start gap-2">
      {line.on ? (
        <Plus size={13} className="mt-1 shrink-0 text-ok" aria-hidden />
      ) : (
        <Minus size={13} className="mt-1 shrink-0 text-danger" aria-hidden />
      )}
      <span>
        <span className="text-muted">
          {t(line.on ? 'assistant.proposal.builtinOn' : 'assistant.proposal.builtinOff')}:{' '}
        </span>
        {line.label}
      </span>
    </li>
  )
}

function ChangeBlock({ change }: { change: AssistantChange }): React.JSX.Element {
  const { t } = useTranslation()
  const accounts = useApp((s) => s.data?.accounts) ?? []
  const ctx = { section: change.section, scope: change.scope, accounts }
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="mb-2 flex flex-wrap items-baseline gap-x-2 text-[12px] font-semibold text-muted">
        <span className="uppercase tracking-wide">
          {t(`settings.sections.${change.section}.label`)}
        </span>
        <span className="font-normal">
          {change.scope === 'project'
            ? t('assistant.proposal.project', { name: change.projectName ?? '' })
            : t('assistant.proposal.global')}
        </span>
      </p>
      <ul className="space-y-1.5">
        {change.diffs.map((diff, i) => (
          <DiffRow key={i} line={describeDiff(diff, ctx, t as Translate)} />
        ))}
      </ul>
    </div>
  )
}

function ExampleRow({ example }: { example: AssistantExample }): React.JSX.Element {
  const { t } = useTranslation()
  const changed = example.before !== example.after
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <code className={`${codeClass} min-w-0`}>{example.input}</code>
      <span className="flex items-center gap-1.5">
        {changed && (
          <>
            <span className="sr-only">{t('assistant.proposal.before')}</span>
            <OutcomeBadge outcome={example.before} />
            <ArrowRight
              size={12}
              className="text-muted"
              aria-label={t('assistant.proposal.becomes')}
            />
          </>
        )}
        <OutcomeBadge outcome={example.after} />
      </span>
    </li>
  )
}

function riskText(risk: AssistantRisk, t: Translate): string {
  const category = (id: string): string => t(`guard.categories.${id}`)
  switch (risk.kind) {
    case 'guardAllow':
      return t('assistant.risks.guardAllow', { category: category(risk.category) })
    case 'guardRelaxed':
      return t('assistant.risks.guardRelaxed', {
        category: category(risk.category),
        action: t(`guard.actions.${risk.to}`)
      })
    default:
      return t(`assistant.risks.${risk.kind}`)
  }
}

/** What Claude proposes: changes from and to, the reason, tested examples and risk notes. */
export function AssistantProposalView({
  proposal
}: {
  proposal: AssistantProposal
}): React.JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="space-y-4">
      <div>
        <h3 id={titleId} className="text-[16px] font-semibold leading-snug tracking-tight">
          {proposal.summary}
        </h3>
        <p className="mt-1 leading-relaxed text-muted">{proposal.reason}</p>
      </div>

      <div className="space-y-2">
        <h4 className="text-[12px] font-medium text-muted">{t('assistant.proposal.changes')}</h4>
        {proposal.changes.map((change, i) => (
          <ChangeBlock key={i} change={change} />
        ))}
      </div>

      {proposal.examples.length > 0 && (
        <div>
          <h4 className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
            <FlaskConical size={13} aria-hidden />
            {t('assistant.proposal.examples')}
          </h4>
          <ul className="mt-1 divide-y divide-border">
            {proposal.examples.map((example, i) => (
              <ExampleRow key={i} example={example} />
            ))}
          </ul>
        </div>
      )}

      {proposal.risks.length > 0 && (
        <div
          role="note"
          className="flex gap-2.5 rounded-lg border border-warn/40 bg-warn/[0.06] p-3"
        >
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden />
          <div className="min-w-0 space-y-1">
            <p className="font-medium">{t('assistant.proposal.risks')}</p>
            <ul className="list-disc space-y-0.5 pl-4 text-[13px]">
              {proposal.risks.map((risk, i) => (
                <li key={i}>{riskText(risk, t as Translate)}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  )
}
