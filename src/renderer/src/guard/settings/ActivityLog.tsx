import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GUARD_LIMITS } from '@shared/guardLimits'
import type { GuardLogEntry } from '@shared/types'
import { useApp } from '../../store'
import { Button } from '../../ui/Button'
import { useGuard } from '../guardStore'
import { ActionBadge } from './ActionBadge'
import { useRuleLabeler } from './useRuleLabeler'

/** How long the copy button shows its done state. */
const COPIED_MS = 1500

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()

/**
 * The last guard decisions with a matching rule (memory only, newest first). Live entries
 * arrive through the guard store's subscription.
 */
export function ActivityLog(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const log = useGuard((s) => s.log)
  const sessions = useApp((s) => s.data?.sessions)
  const projects = useApp((s) => s.data?.projects)
  const ruleLabel = useRuleLabeler()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void useGuard.getState().loadLog()
  }, [])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  if (!log) return <p className="text-[12px] text-muted">{t('testQueue.loading')}</p>

  const now = new Date()
  const time = (at: number): string => {
    const date = new Date(at)
    return new Intl.DateTimeFormat(i18n.language, {
      ...(sameDay(date, now) ? {} : { day: 'numeric', month: 'short' }),
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(date)
  }
  const where = (entry: GuardLogEntry): string =>
    [
      projects?.find((p) => p.id === entry.projectId)?.name,
      sessions?.find((s) => s.id === entry.sessionId)?.title
    ]
      .filter(Boolean)
      .join(' · ')
  const describe = (entry: GuardLogEntry): string[] => [
    time(entry.at),
    where(entry),
    t(`guard.categories.${entry.category}`),
    ruleLabel(entry.ruleId, entry.projectId),
    t(`guard.actions.${entry.action}`),
    entry.excerpt
  ]
  const copy = (): void => {
    const text = log.map((entry) => describe(entry).join('\t')).join('\n')
    void navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => useApp.getState().setError('UNKNOWN')
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] leading-snug text-muted">
          {t('guard.log.hint', { max: GUARD_LIMITS.logSize })}
        </p>
        <Button disabled={log.length === 0} onClick={copy} className="shrink-0 !px-2 !py-1">
          {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          {copied ? t('guard.log.copied') : t('guard.log.copy')}
        </Button>
      </div>
      {log.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted">
          {t('guard.log.empty')}
        </p>
      ) : (
        <ol
          aria-label={t('guard.log.title')}
          className="scroll-area max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border"
        >
          {log.map((entry) => {
            const place = where(entry)
            return (
              <li key={entry.id} className="space-y-0.5 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2 text-[12px]">
                  <ActionBadge action={entry.action} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{t(`guard.categories.${entry.category}`)}</span>
                    <span className="text-muted">
                      {' '}
                      · {ruleLabel(entry.ruleId, entry.projectId)}
                    </span>
                  </span>
                  <time
                    dateTime={new Date(entry.at).toISOString()}
                    className="shrink-0 text-[11px] tabular-nums text-muted"
                  >
                    {time(entry.at)}
                  </time>
                </div>
                <code
                  className="block truncate font-mono text-[11.5px] [font-variant-ligatures:none]"
                  data-tooltip={entry.excerpt}
                >
                  {entry.excerpt}
                </code>
                {place && <p className="truncate text-[11px] text-muted">{place}</p>}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
