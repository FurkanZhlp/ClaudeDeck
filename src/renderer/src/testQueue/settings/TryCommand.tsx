import { CircleCheck, CircleSlash } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClassifyResult, TestPattern } from '@shared/types'
import { useApp } from '../../store'
import { inputClass } from '../../ui/styles'
import { useTestQueue } from '../testQueueStore'

/** Waits for a pause in typing before asking the main process. */
const DEBOUNCE_MS = 250

/** "Try a command": classifies what the user types with the current rules. */
export function TryCommand({ projectId }: { projectId?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [command, setCommand] = useState('')
  const [result, setResult] = useState<ClassifyResult | null>(null)
  // Rules changed: classify again, so the answer always matches what is saved.
  const settings = useApp((s) => s.data?.settings.testQueue)
  const project = useApp((s) => s.data?.projects.find((p) => p.id === projectId))

  useEffect(() => {
    const text = command.trim()
    if (!text) return
    let alive = true
    const timer = setTimeout(() => {
      window.api.testQueue
        .classify(text, projectId)
        .then((value) => alive && setResult(value))
        .catch(() => alive && setResult(null))
    }, DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [command, projectId, settings, project])

  return (
    <div className="space-y-1.5">
      <input
        className={`${inputClass} font-mono`}
        aria-label={t('testQueue.try.label')}
        placeholder={t('testQueue.try.placeholder')}
        spellCheck={false}
        value={command}
        onChange={(event) => setCommand(event.target.value)}
      />
      <div aria-live="polite" className="min-h-5 text-[12px]">
        {command.trim() && result && <Verdict result={result} projectId={projectId} />}
      </div>
    </div>
  )
}

function Verdict({
  result,
  projectId
}: {
  result: ClassifyResult
  projectId?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const rule = useRuleLabel(result, projectId)

  if (result.isTest) {
    return (
      <p className="flex items-start gap-1.5 text-ok">
        <CircleCheck size={13} aria-hidden className="mt-0.5 shrink-0" />
        <span>
          {t('testQueue.try.match', { rule, source: t(`testQueue.try.source.${result.source}`) })}
          {result.segment && (
            <>
              {' '}
              <code className="font-mono text-fg">{result.segment}</code>
            </>
          )}
        </span>
      </p>
    )
  }
  const reason = result.excludedBy
    ? t('testQueue.try.excluded', { rule, flag: result.excludedBy })
    : t('testQueue.try.noMatch')
  return (
    <p className="flex items-start gap-1.5 text-muted">
      <CircleSlash size={13} aria-hidden className="mt-0.5 shrink-0" />
      <span>
        {reason}
        {result.truncated && ` ${t('testQueue.try.truncated')}`}
      </span>
    </p>
  )
}

/** Readable name of the rule in a result: a built-in label or the custom pattern itself. */
function useRuleLabel(result: ClassifyResult, projectId?: string): string {
  const { t } = useTranslation()
  const builtins = useTestQueue((s) => s.builtins)
  const global = useApp((s) => s.data?.settings.testQueue.customPatterns)
  const local = useApp((s) => s.data?.projects.find((p) => p.id === projectId)?.testQueue)
  const id = result.ruleId
  if (!id) return ''
  const builtin = builtins?.find((b) => b.id === id)
  if (builtin) return t(`testQueue.builtinLabels.${builtin.id}`, { defaultValue: builtin.label })
  const custom: TestPattern | undefined = [
    ...(global ?? []),
    ...(local?.customPatterns ?? [])
  ].find((p) => p.id === id)
  return custom?.pattern ?? id
}
