import { Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TestPattern } from '@shared/types'
import { TEST_QUEUE_LIMITS } from '@shared/testQueueLimits'
import { Button } from '../../ui/Button'
import { Segmented } from '../../ui/Segmented'
import { inputClass } from '../../ui/styles'
import { checkPattern } from '../queueModel'

type Kind = TestPattern['kind']
type Target = NonNullable<TestPattern['target']>

interface Props {
  patterns: readonly TestPattern[]
  /** Saves the whole list; resolves to an error code, or null on success. */
  onSave: (patterns: TestPattern[]) => Promise<string | null>
}

/** User rules that mark more commands as tests: a list with remove buttons and an add form. */
export function CustomRules({ patterns, onSave }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const errorId = useId()
  const [kind, setKind] = useState<Kind>('prefix')
  const [target, setTarget] = useState<Target>('canonical')
  const [pattern, setPattern] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const full = patterns.length >= TEST_QUEUE_LIMITS.maxPatterns

  const save = async (next: TestPattern[]): Promise<boolean> => {
    setBusy(true)
    const code = await onSave(next)
    setBusy(false)
    if (code) setError(t(code === 'INVALID' ? 'testQueue.rules.rejected' : `errors.${code}`))
    return code === null
  }

  const add = async (): Promise<void> => {
    const check = checkPattern(kind, pattern, TEST_QUEUE_LIMITS.maxPatternLength)
    if (!check.ok) {
      setError(
        t(`testQueue.rules.${check.reason}`, {
          detail: check.detail,
          max: TEST_QUEUE_LIMITS.maxPatternLength
        })
      )
      return
    }
    const rule: TestPattern = {
      id: crypto.randomUUID(),
      kind,
      pattern: pattern.trim(),
      ...(kind === 'regex' ? { target } : {})
    }
    if (await save([...patterns, rule])) {
      setPattern('')
      setError(null)
    }
  }

  return (
    <div className="space-y-2">
      {patterns.length === 0 ? (
        <p className="text-[12px] text-muted">{t('testQueue.rules.none')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {patterns.map((rule) => (
            <li key={rule.id} className="flex items-center gap-2 px-3 py-1.5">
              <span className="shrink-0 rounded bg-fg/[0.07] px-1.5 text-[10.5px] font-medium text-muted">
                {t(`testQueue.rules.kind.${rule.kind}`)}
                {rule.kind === 'regex' &&
                  ` · ${t(`testQueue.rules.target.${rule.target ?? 'canonical'}`)}`}
              </span>
              <code
                className="min-w-0 flex-1 truncate font-mono text-[12px]"
                data-tooltip={rule.pattern}
              >
                {rule.pattern}
              </code>
              <button
                type="button"
                aria-label={t('testQueue.rules.remove', { pattern: rule.pattern })}
                data-tooltip={t('testQueue.rules.removeShort')}
                disabled={busy}
                className="rounded p-1 text-muted hover:bg-fg/[0.08] hover:text-danger focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
                onClick={() => void save(patterns.filter((p) => p.id !== rule.id))}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Not a <form>: the project dialog around it already is one. */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<Kind>
            label={t('testQueue.rules.kindLabel')}
            value={kind}
            options={[
              { value: 'prefix', label: t('testQueue.rules.kind.prefix') },
              { value: 'regex', label: t('testQueue.rules.kind.regex') }
            ]}
            onChange={(value) => {
              setKind(value)
              setError(null)
            }}
          />
          {kind === 'regex' && (
            <select
              aria-label={t('testQueue.rules.targetLabel')}
              className={`${inputClass} !w-auto max-w-60`}
              value={target}
              onChange={(event) => setTarget(event.target.value as Target)}
            >
              <option value="canonical">{t('testQueue.rules.target.canonical')}</option>
              <option value="raw">{t('testQueue.rules.target.raw')}</option>
            </select>
          )}
        </div>
        <div className="flex gap-2">
          <input
            className={`${inputClass} flex-1 font-mono`}
            aria-label={t('testQueue.rules.patternLabel')}
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            placeholder={t(`testQueue.rules.placeholder.${kind}`)}
            value={pattern}
            maxLength={TEST_QUEUE_LIMITS.maxPatternLength + 1}
            disabled={full}
            spellCheck={false}
            onChange={(event) => {
              setPattern(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              if (!busy && pattern.trim()) void add()
            }}
          />
          <Button disabled={busy || full || !pattern.trim()} onClick={() => void add()}>
            <Plus size={14} />
            {t('testQueue.rules.add')}
          </Button>
        </div>
        {error && (
          <p id={errorId} role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
        <p className="text-[12px] leading-snug text-muted">
          {full
            ? t('testQueue.rules.full', { max: TEST_QUEUE_LIMITS.maxPatterns })
            : t(`testQueue.rules.help.${kind}`)}
        </p>
      </div>
    </div>
  )
}
