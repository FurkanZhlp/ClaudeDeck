import { Check, HardDrive, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ProfileCategory,
  ProfileCategorySummary,
  ProfileDiffEntry,
  ProfileImportResult,
  ProfileSource
} from '@shared/types'
import { errorCode, useApp } from '../store'
import { AccountDot } from '../ui/AccountDot'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { sectionTitleClass } from '../ui/styles'
import { useOnboarding } from './onboardingStore'

const GLOBAL_KEY = 'global'

interface Loaded {
  key: string
  summary: ProfileCategorySummary[]
  /** Per-category changes; only kept when importing would replace existing profile content. */
  diff: Map<ProfileCategory, ProfileDiffEntry> | null
}

const toSource = (key: string): ProfileSource =>
  key === GLOBAL_KEY ? { kind: 'global' } : { kind: 'account', accountId: key }

export function ImportStep({ accountId }: { accountId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const next = useOnboarding((s) => s.next)
  const setImported = useOnboarding((s) => s.setImported)
  const accounts = useApp((s) => s.data?.accounts)
  const others = useMemo(
    () => (accounts ?? []).filter((account) => account.id !== accountId),
    [accounts, accountId]
  )

  const [key, setKey] = useState(GLOBAL_KEY)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [selected, setSelected] = useState<Set<ProfileCategory>>(new Set())
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ProfileImportResult | null>(null)
  // Shown inline: the global error toast sits behind the onboarding screen.
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const source = toSource(key)
    Promise.all([window.api.profile.summarize(source), window.api.profile.diff(accountId, source)])
      .then(([summary, diff]) => {
        if (cancelled) return
        const replaces = diff.some((entry) => entry.changed > 0 || entry.removed > 0)
        setLoaded({
          key,
          summary,
          diff: replaces ? new Map(diff.map((entry) => [entry.category, entry])) : null
        })
        setSelected(new Set(summary.filter((s) => s.available).map((s) => s.category)))
      })
      .catch((error) => {
        if (cancelled) return
        setFailure(errorCode(error))
        setLoaded({ key, summary: [], diff: null })
        setSelected(new Set())
      })
    return () => {
      cancelled = true
    }
  }, [key, accountId])

  const loading = loaded?.key !== key
  const available = loaded && !loading ? loaded.summary.filter((s) => s.available) : []

  const selectSource = (nextKey: string): void => {
    setFailure(null)
    setKey(nextKey)
  }

  const toggle = (category: ProfileCategory): void => {
    setSelected((prev) => {
      const nextSet = new Set(prev)
      if (nextSet.has(category)) nextSet.delete(category)
      else nextSet.add(category)
      return nextSet
    })
  }

  const runImport = async (): Promise<void> => {
    if (!selected.size || importing) return
    setImporting(true)
    setFailure(null)
    try {
      const categories = [...selected]
      const imported = await window.api.profile.import(accountId, toSource(key), categories)
      setResult(imported)
      setImported(imported.imported)
    } catch (error) {
      setFailure(errorCode(error))
    } finally {
      setImporting(false)
    }
  }

  if (result) {
    return (
      <div>
        <div className="flex gap-3" role="status">
          <span
            aria-hidden
            className="animate-pop-in flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg"
          >
            <Check size={14} strokeWidth={3} />
          </span>
          <div className="min-w-0 pt-0.5">
            <div className="font-medium">
              {t('onboarding.import.done', { count: result.imported.length })}
            </div>
            <p className="mt-0.5 text-muted">
              {result.imported.map((c) => t(`onboarding.categories.${c}`)).join(', ')}
            </p>
            {result.backupDir && (
              <p className="mt-2 text-[12px] text-muted">
                {t('onboarding.import.backup')}{' '}
                <span className="select-text break-all font-mono text-fg">{result.backupDir}</span>
              </p>
            )}
          </div>
        </div>
        <div className="mt-6 flex justify-end">
          <Button variant="primary" data-autofocus onClick={next}>
            {t('onboarding.continue')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <fieldset disabled={importing}>
        <legend className={`${sectionTitleClass} mb-2`}>{t('onboarding.import.source')}</legend>
        <div role="radiogroup" aria-label={t('onboarding.import.source')} className="grid gap-2">
          <SourceOption
            checked={key === GLOBAL_KEY}
            onSelect={() => selectSource(GLOBAL_KEY)}
            icon={<HardDrive size={14} className="text-accent" />}
            title={t('onboarding.import.global')}
            hint={t('onboarding.import.globalHint')}
            autoFocus
          />
          {others.map((account) => (
            <SourceOption
              key={account.id}
              checked={key === account.id}
              onSelect={() => selectSource(account.id)}
              icon={<AccountDot color={account.color} size={10} />}
              title={account.name}
              hint={account.email ?? t('onboarding.import.accountHint')}
            />
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-5" disabled={importing || loading}>
        <legend className={`${sectionTitleClass} mb-2`}>{t('onboarding.import.categories')}</legend>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-muted" role="status">
            <Loader2 size={14} className="animate-spin" />
            {t('onboarding.import.loading')}
          </div>
        ) : (
          <>
            <ul className="divide-y divide-border rounded-lg border border-border bg-bg">
              {loaded?.summary.map((item) => (
                <CategoryRow
                  key={item.category}
                  item={item}
                  diff={loaded.diff?.get(item.category)}
                  checked={selected.has(item.category)}
                  onToggle={() => toggle(item.category)}
                />
              ))}
            </ul>
            {available.length === 0 && (
              <p className="mt-2 text-[12px] text-muted">{t('onboarding.import.nothing')}</p>
            )}
            {loaded?.diff && (
              <p className="mt-2 text-[12px] text-muted">{t('onboarding.import.replaceHint')}</p>
            )}
          </>
        )}
      </fieldset>

      {failure && (
        <div className="mt-5" role="alert">
          <Notice tone="danger">
            <p>{t(`errors.${failure}`, { defaultValue: t('errors.UNKNOWN') })}</p>
          </Notice>
        </div>
      )}

      <div className="mt-6 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={next} disabled={importing}>
          {t('onboarding.skip')}
        </Button>
        <Button
          variant="primary"
          onClick={() => void runImport()}
          disabled={loading || importing || selected.size === 0}
        >
          {importing && <Loader2 size={14} className="animate-spin" />}
          {importing ? t('onboarding.import.importing') : t('onboarding.import.import')}
        </Button>
      </div>
    </div>
  )
}

function SourceOption({
  checked,
  onSelect,
  icon,
  title,
  hint,
  autoFocus
}: {
  checked: boolean
  onSelect: () => void
  icon: React.ReactNode
  title: string
  hint: string
  autoFocus?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-autofocus={autoFocus || undefined}
      onClick={onSelect}
      className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
        checked ? 'border-accent bg-accent/5' : 'border-border bg-bg hover:border-muted/50'
      }`}
    >
      <span
        aria-hidden
        className={`flex size-4 shrink-0 items-center justify-center rounded-full border-2 ${
          checked ? 'border-accent' : 'border-border'
        }`}
      >
        {checked && <span className="animate-pop-in size-1.5 rounded-full bg-accent" />}
      </span>
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        <span className="block truncate text-[12px] text-muted">{hint}</span>
      </span>
    </button>
  )
}

function CategoryRow({
  item,
  diff,
  checked,
  onToggle
}: {
  item: ProfileCategorySummary
  diff: ProfileDiffEntry | undefined
  checked: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const changes = diff && diff.added + diff.changed + diff.removed > 0 ? diff : null
  return (
    <li>
      <label
        className={`flex items-center gap-3 px-3 py-2 ${
          item.available ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
        }`}
      >
        <input
          type="checkbox"
          className="accent-[var(--accent)]"
          checked={item.available && checked}
          disabled={!item.available}
          onChange={onToggle}
        />
        <span className="min-w-0 flex-1">
          <span className="block">{t(`onboarding.categories.${item.category}`)}</span>
          {changes && item.available && (
            <span className="block text-[12px] text-muted">
              {t('onboarding.import.diff', {
                added: changes.added,
                changed: changes.changed,
                removed: changes.removed
              })}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[12px] tabular-nums text-muted">
          {item.available
            ? t('onboarding.import.items', { count: item.items })
            : t('onboarding.import.unavailable')}
        </span>
      </label>
    </li>
  )
}
