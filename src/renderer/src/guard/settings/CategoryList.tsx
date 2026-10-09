import { ChevronRight, Info } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GUARD_ACTIONS, GUARD_CATEGORIES } from '@shared/guardLimits'
import type { GuardAction, GuardCategoryId, GuardRuleInfo, GuardSettings } from '@shared/types'
import { Segmented } from '../../ui/Segmented'
import { inputClass } from '../../ui/styles'
import {
  FOLLOW_CATEGORY,
  followedRuleAction,
  needsAllowConfirm,
  overrideCount,
  ruleActionAvailable,
  rulesByCategory,
  withRuleChoice,
  type RuleChoice
} from '../guardModel'
import { useGuard } from '../guardStore'
import { useAllowConfirm } from './useAllowConfirm'
import { CATEGORY_ICONS } from './categoryIcons'

interface Props {
  settings: GuardSettings
  save: (patch: Partial<GuardSettings>) => void
}

/** Built-in categories with their action; each expands to its rules and their overrides. */
export function CategoryList({ settings, save }: Props): React.JSX.Element {
  const rules = useGuard((s) => s.rules)
  const { confirm, dialog } = useAllowConfirm()

  useEffect(() => {
    void useGuard.getState().loadRules()
  }, [])

  const groups = rulesByCategory(rules ?? [])
  const setCategory = (category: GuardCategoryId, action: GuardAction): void =>
    confirm(category, needsAllowConfirm(category, action), () =>
      save({ categories: { ...settings.categories, [category]: action } })
    )
  const setRule = (category: GuardCategoryId, ruleId: string, choice: RuleChoice): void =>
    confirm(category, needsAllowConfirm(category, choice), () =>
      save({ ruleOverrides: withRuleChoice(settings.ruleOverrides, ruleId, choice) })
    )

  return (
    <>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {GUARD_CATEGORIES.map(({ id }) => (
          <CategoryRow
            key={id}
            category={id}
            action={settings.categories[id]}
            rules={groups.get(id) ?? []}
            overrides={settings.ruleOverrides}
            loading={!rules}
            onCategory={(action) => setCategory(id, action)}
            onRule={(ruleId, choice) => setRule(id, ruleId, choice)}
          />
        ))}
      </ul>
      {dialog}
    </>
  )
}

function CategoryRow({
  category,
  action,
  rules,
  overrides,
  loading,
  onCategory,
  onRule
}: {
  category: GuardCategoryId
  action: GuardAction
  rules: readonly GuardRuleInfo[]
  overrides: Readonly<Record<string, GuardAction>>
  loading: boolean
  onCategory: (action: GuardAction) => void
  onRule: (ruleId: string, choice: RuleChoice) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const Icon = CATEGORY_ICONS[category]
  const name = t(`guard.categories.${category}`)
  const changed = overrideCount(rules, overrides)
  const examples = t(`guard.categoryInfo.${category}.examples`)

  return (
    <li data-setting={`guard.categories.${category}`}>
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span
          aria-hidden
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-fg/[0.06] text-muted"
        >
          <Icon size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="font-medium">{name}</span>
            <span
              tabIndex={0}
              role="img"
              aria-label={t('guard.settings.examplesLabel', { examples })}
              data-tooltip={t('guard.settings.examplesLabel', { examples })}
              className="rounded text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
            >
              <Info size={12} aria-hidden />
            </span>
          </span>
          <span className="block text-[12px] leading-snug text-muted">
            {t(`guard.categoryInfo.${category}.description`)}
          </span>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            disabled={loading}
            className="-ml-1 mt-1 inline-flex items-center gap-1 rounded px-1 text-[12px] text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronRight
              size={12}
              aria-hidden
              className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
            />
            {t('guard.settings.rulesToggle', { count: rules.length })}
            {changed > 0 && (
              <span className="text-accent">
                {' · '}
                {t('guard.settings.overridden', { count: changed })}
              </span>
            )}
          </button>
        </span>
        <Segmented<GuardAction>
          label={t('guard.settings.categoryAction', { category: name })}
          value={action}
          options={GUARD_ACTIONS.map((value) => ({ value, label: t(`guard.actions.${value}`) }))}
          onChange={onCategory}
        />
      </div>
      {open && (
        <ul
          id={panelId}
          aria-label={t('guard.settings.rulesOf', { category: name })}
          className="space-y-1 border-t border-border bg-fg/[0.02] py-2 pl-[52px] pr-3"
        >
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              categoryAction={action}
              choice={overrides[rule.id] ?? FOLLOW_CATEGORY}
              onChange={(choice) => onRule(rule.id, choice)}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function RuleRow({
  rule,
  categoryAction,
  choice,
  onChange
}: {
  rule: GuardRuleInfo
  categoryAction: GuardAction
  choice: RuleChoice
  onChange: (choice: RuleChoice) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const hintId = useId()
  const label = t(rule.label)
  const followed = followedRuleAction(rule, categoryAction)
  const followedLabel =
    followed.source === 'default'
      ? t('guard.settings.ruleDefault', { action: t(`guard.actions.${followed.action}`) })
      : t('guard.settings.followCategory', { action: t(`guard.actions.${followed.action}`) })
  const hint = rule.defaultAction
    ? t('guard.settings.ruleDefaultHint')
    : rule.maxAction
      ? t('guard.settings.ruleCappedHint')
      : null
  return (
    <li className="flex items-center gap-3 py-0.5">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[12.5px] leading-snug">
          <span className="min-w-0">{label}</span>
          {hint && (
            <span
              tabIndex={0}
              role="img"
              aria-label={hint}
              data-tooltip={hint}
              className="shrink-0 rounded text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
            >
              <Info size={12} aria-hidden />
            </span>
          )}
        </span>
        <code
          className="block truncate font-mono text-[11px] text-muted [font-variant-ligatures:none]"
          data-tooltip={rule.example}
        >
          {rule.example}
        </code>
        {hint && (
          <span id={hintId} hidden>
            {hint}
          </span>
        )}
      </span>
      <select
        aria-label={t('guard.settings.ruleAction', { rule: label })}
        aria-describedby={hint ? hintId : undefined}
        className={`${inputClass} !w-auto shrink-0 !py-1 text-[12px] ${choice === FOLLOW_CATEGORY ? 'text-muted' : ''}`}
        value={choice}
        onChange={(event) => onChange(event.target.value as RuleChoice)}
      >
        <option value={FOLLOW_CATEGORY}>{followedLabel}</option>
        {GUARD_ACTIONS.map((value) => (
          <option key={value} value={value} disabled={!ruleActionAvailable(rule, value)}>
            {t(`guard.actions.${value}`)}
          </option>
        ))}
      </select>
    </li>
  )
}
