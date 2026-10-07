import { ChevronRight } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { TestQueueBuiltin, TestQueueBuiltinGroup } from '@shared/types'
import { Switch } from '../../ui/Switch'
import { useTestQueue } from '../testQueueStore'

interface Props {
  /** Ids switched off in the list being edited. */
  disabled: readonly string[]
  /** Ids already off globally (project dialog): shown off and locked. */
  lockedOff?: readonly string[]
  onChange: (disabled: string[]) => void
}

/** Built-in patterns, then the exclusions, as one collapsible group per ecosystem. */
export function BuiltinList({ disabled, lockedOff = [], onChange }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const builtins = useTestQueue((s) => s.builtins)

  useEffect(() => {
    void useTestQueue.getState().loadBuiltins()
  }, [])

  if (!builtins) return <p className="text-[12px] text-muted">{t('testQueue.loading')}</p>
  const groups = groupBuiltins(builtins)
  const toggle = (id: string, on: boolean): void =>
    onChange(on ? disabled.filter((x) => x !== id) : [...disabled, id])

  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      {groups.map(([group, items]) => {
        const onCount = items.filter(
          (b) => !disabled.includes(b.id) && !lockedOff.includes(b.id)
        ).length
        return (
          <details key={group} className="group/details">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] hover:bg-fg/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
              <ChevronRight
                size={13}
                aria-hidden
                className="shrink-0 text-muted transition-transform group-open/details:rotate-90 motion-reduce:transition-none"
              />
              <span className="min-w-0 flex-1 truncate">{t(`testQueue.groups.${group}`)}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted">
                {t('testQueue.builtinsOn', { on: onCount, total: items.length })}
              </span>
            </summary>
            <div className="space-y-1 px-3 pb-2 pl-8">
              {items.map((builtin) => {
                const locked = lockedOff.includes(builtin.id)
                return (
                  <Switch
                    key={builtin.id}
                    label={t(`testQueue.builtinLabels.${builtin.id}`, {
                      defaultValue: builtin.label
                    })}
                    hint={
                      locked
                        ? t('testQueue.offGlobally')
                        : t(
                            group === 'exclusions'
                              ? 'testQueue.exclusionExample'
                              : 'testQueue.example',
                            { command: builtin.example }
                          )
                    }
                    checked={!locked && !disabled.includes(builtin.id)}
                    disabled={locked}
                    onChange={(on) => toggle(builtin.id, on)}
                  />
                )
              })}
            </div>
          </details>
        )
      })}
    </div>
  )
}

/** Groups in the order the main process lists them. */
function groupBuiltins(
  builtins: readonly TestQueueBuiltin[]
): Array<[TestQueueBuiltinGroup, TestQueueBuiltin[]]> {
  const groups = new Map<TestQueueBuiltinGroup, TestQueueBuiltin[]>()
  for (const builtin of builtins) {
    const list = groups.get(builtin.group)
    if (list) list.push(builtin)
    else groups.set(builtin.group, [builtin])
  }
  return [...groups]
}
