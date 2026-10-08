import { Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GUARD_ACTIONS, GUARD_LIMITS } from '@shared/guardLimits'
import type { GuardAction, GuardCustomRule } from '@shared/types'
import { Button } from '../../ui/Button'
import { Segmented } from '../../ui/Segmented'
import { inputClass } from '../../ui/styles'
import { checkGuardPattern } from '../guardModel'

type Kind = GuardCustomRule['kind']
type Target = NonNullable<GuardCustomRule['target']>

interface Props {
  rules: readonly GuardCustomRule[]
  /** Saves the whole list; resolves to an error code, or null on success. */
  onSave: (rules: GuardCustomRule[]) => Promise<string | null>
}

const selectClass = `${inputClass} !w-auto shrink-0 !py-1 text-[12px]`

/** User rules with their own action: a list (action editable, remove) and an add form. */
export function GuardCustomRules({ rules, onSave }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const errorId = useId()
  const [kind, setKind] = useState<Kind>('prefix')
  const [target, setTarget] = useState<Target>('canonical')
  const [action, setAction] = useState<GuardAction>('ask')
  const [pattern, setPattern] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const full = rules.length >= GUARD_LIMITS.maxCustomRules

  const save = async (next: GuardCustomRule[]): Promise<boolean> => {
    setBusy(true)
    const code = await onSave(next)
    setBusy(false)
    if (code) setError(t(code === 'INVALID' ? 'guard.custom.rejected' : `errors.${code}`))
    return code === null
  }

  const add = async (): Promise<void> => {
    const check = checkGuardPattern(kind, pattern)
    if (!check.ok) {
      setError(
        t(`guard.custom.${check.reason}`, {
          detail: check.detail,
          max: GUARD_LIMITS.maxPatternLength
        })
      )
      return
    }
    const rule: GuardCustomRule = {
      id: crypto.randomUUID(),
      kind,
      pattern: pattern.trim(),
      action,
      ...(kind === 'regex' ? { target } : {})
    }
    if (await save([...rules, rule])) {
      setPattern('')
      setError(null)
    }
  }

  const actionOptions = GUARD_ACTIONS.map((value) => (
    <option key={value} value={value}>
      {t(`guard.actions.${value}`)}
    </option>
  ))

  return (
    <div className="space-y-2">
      {rules.length === 0 ? (
        <p className="text-[12px] text-muted">{t('guard.custom.none')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rules.map((rule) => (
            <li key={rule.id} className="flex items-center gap-2 px-3 py-1.5">
              <span className="shrink-0 rounded bg-fg/[0.07] px-1.5 text-[10.5px] font-medium text-muted">
                {t(`testQueue.rules.kind.${rule.kind}`)}
                {rule.kind === 'regex' &&
                  ` · ${t(`testQueue.rules.target.${rule.target ?? 'canonical'}`)}`}
              </span>
              <code
                className="min-w-0 flex-1 truncate font-mono text-[12px] [font-variant-ligatures:none]"
                data-tooltip={rule.pattern}
              >
                {rule.pattern}
              </code>
              <select
                aria-label={t('guard.custom.ruleAction', { pattern: rule.pattern })}
                className={selectClass}
                value={rule.action}
                disabled={busy}
                onChange={(event) =>
                  void save(
                    rules.map((r) =>
                      r.id === rule.id ? { ...r, action: event.target.value as GuardAction } : r
                    )
                  )
                }
              >
                {actionOptions}
              </select>
              <button
                type="button"
                aria-label={t('testQueue.rules.remove', { pattern: rule.pattern })}
                data-tooltip={t('testQueue.rules.removeShort')}
                disabled={busy}
                className="rounded p-1 text-muted hover:bg-fg/[0.08] hover:text-danger focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
                onClick={() => void save(rules.filter((r) => r.id !== rule.id))}
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
          <label className="ml-auto flex items-center gap-2 text-[12px] text-muted">
            {t('guard.custom.actionLabel')}
            <select
              className={`${inputClass} !w-auto`}
              value={action}
              onChange={(event) => setAction(event.target.value as GuardAction)}
            >
              {actionOptions}
            </select>
          </label>
        </div>
        <div className="flex gap-2">
          <input
            className={`${inputClass} flex-1 font-mono [font-variant-ligatures:none]`}
            aria-label={t('testQueue.rules.patternLabel')}
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            placeholder={t(`guard.custom.placeholder.${kind}`)}
            value={pattern}
            maxLength={GUARD_LIMITS.maxPatternLength + 1}
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
            ? t('testQueue.rules.full', { max: GUARD_LIMITS.maxCustomRules })
            : t(`guard.custom.help.${kind}`)}
        </p>
      </div>
    </div>
  )
}
