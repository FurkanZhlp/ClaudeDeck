import { useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { navTargetIndex } from './navKeys'
import { settingsGroups, type SettingsSection } from './registry'
import type { SettingsSectionId } from './sectionIds'

interface Props {
  sections: readonly SettingsSection[]
  active: SettingsSectionId
  onSelect: (id: SettingsSectionId) => void
}

/**
 * Grouped section list. Up/Down (and Home/End) move focus between items, Enter/Space selects
 * (native button behaviour); the current page carries aria-current.
 */
export function SettingsNav({ sections, active, onSelect }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement>(null)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[data-settings-nav-item]') ?? []
    )
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = navTargetIndex(event.key, current, items.length)
    if (next === null) return
    event.preventDefault()
    items[next]?.focus()
  }

  return (
    <nav
      aria-label={t('settings.navLabel')}
      className="scroll-area flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-6"
    >
      <h2 className="px-2.5 pb-4 pt-1 text-[15px] font-semibold tracking-tight">
        {t('settings.title')}
      </h2>
      <div ref={listRef} onKeyDown={onKeyDown} className="space-y-5">
        {settingsGroups.map((group) => {
          const items = sections.filter((section) => section.group === group.id)
          if (items.length === 0) return null
          const headingId = `settings-nav-group-${group.id}`
          return (
            <div key={group.id} role="group" aria-labelledby={headingId}>
              <h3
                id={headingId}
                className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted"
              >
                {t(group.labelKey)}
              </h3>
              <ul className="space-y-0.5">
                {items.map((section) => {
                  const current = section.id === active
                  const Icon = section.icon
                  return (
                    <li key={section.id}>
                      <button
                        type="button"
                        data-settings-nav-item
                        data-section={section.id}
                        aria-current={current ? 'page' : undefined}
                        onClick={() => onSelect(section.id)}
                        className={`no-drag flex min-h-8 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left leading-snug transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none ${
                          current
                            ? 'bg-elevated font-medium text-fg shadow-[0_1px_2px_rgb(0_0_0/0.06)] ring-1 ring-border'
                            : 'text-muted hover:bg-elevated/60 hover:text-fg'
                        }`}
                      >
                        <Icon
                          size={15}
                          aria-hidden
                          className={`shrink-0 ${current ? 'text-accent' : 'text-current'}`}
                        />
                        <span className="min-w-0 flex-1">{t(section.labelKey)}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
    </nav>
  )
}
