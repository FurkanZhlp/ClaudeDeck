import { CircleCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GUARD_LIMITS } from '@shared/guardLimits'
import type { GuardDecision, GuardTool } from '@shared/types'
import { useApp } from '../../store'
import { inputClass } from '../../ui/styles'
import { ActionBadge } from './ActionBadge'
import { useRuleLabeler } from './useRuleLabeler'

/** Waits for a pause in typing before asking the main process. */
const DEBOUNCE_MS = 250

/** Tools offered here: two shells and a file path (Write stands for the file tools). */
const TOOLS: readonly GuardTool[] = ['Bash', 'PowerShell', 'Write']

/**
 * "Try a command": shows what the guard would decide with the saved settings. The main process
 * only evaluates the text; nothing is ever run.
 */
export function GuardTryCommand({ projectId }: { projectId?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [tool, setTool] = useState<GuardTool>('Bash')
  const [input, setInput] = useState('')
  const [result, setResult] = useState<GuardDecision | null>(null)
  // Settings changed: evaluate again, so the answer always matches what is saved.
  const settings = useApp((s) => s.data?.settings.guard)
  const project = useApp((s) => s.data?.projects.find((p) => p.id === projectId))

  useEffect(() => {
    const text = input.trim()
    if (!text) return
    let alive = true
    const timer = setTimeout(() => {
      window.api.guard
        .evaluate({ tool, input: text, projectId })
        .then((value) => alive && setResult(value))
        .catch(() => alive && setResult(null))
    }, DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [input, tool, projectId, settings, project])

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <select
          aria-label={t('guard.try.toolLabel')}
          className={`${inputClass} !w-auto shrink-0`}
          value={tool}
          onChange={(event) => setTool(event.target.value as GuardTool)}
        >
          {TOOLS.map((value) => (
            <option key={value} value={value}>
              {t(`guard.try.tools.${value}`)}
            </option>
          ))}
        </select>
        <input
          className={`${inputClass} min-w-0 flex-1 font-mono [font-variant-ligatures:none]`}
          aria-label={t('guard.try.label')}
          placeholder={t(`guard.try.placeholder.${tool === 'Write' ? 'path' : 'command'}`)}
          spellCheck={false}
          maxLength={GUARD_LIMITS.maxEvaluateInput}
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
      </div>
      <div aria-live="polite" className="min-h-5 text-[12px]">
        {input.trim() && result && <Verdict decision={result} projectId={projectId} />}
      </div>
      <p className="text-[12px] leading-snug text-muted">{t('guard.try.note')}</p>
    </div>
  )
}

function Verdict({
  decision,
  projectId
}: {
  decision: GuardDecision
  projectId?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const ruleLabel = useRuleLabeler()(decision.ruleId, projectId)

  if (!decision.category || !decision.ruleId) {
    return (
      <p className="flex items-start gap-1.5 text-ok">
        <CircleCheck size={13} aria-hidden className="mt-0.5 shrink-0" />
        <span>{t('guard.try.noMatch')}</span>
      </p>
    )
  }
  return (
    <div className="space-y-1 rounded-lg border border-border bg-fg/[0.02] px-3 py-2">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <ActionBadge action={decision.action} />
        <span>
          {t('guard.try.result', {
            category: t(`guard.categories.${decision.category}`),
            rule: ruleLabel
          })}
        </span>
      </p>
      <p className="leading-snug text-muted">{t(`guard.try.effect.${decision.action}`)}</p>
    </div>
  )
}
