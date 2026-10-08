import { X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { SettingsNav } from './SettingsNav'
import { resolveSettingsSection, visibleSettingsSections } from './registry'

/** Settings mount point: a full-window view over the workspace while open. */
export function SettingsView(): React.JSX.Element | null {
  const open = useApp((s) => s.settingsOpen)
  return open ? <SettingsScreen /> : null
}

/**
 * Something above the settings view owns Escape: a full-window screen (sign-in, onboarding)
 * or a modal dialog opened from a section.
 */
const escapeOwnedAbove = (): boolean =>
  document.querySelector('[data-screen], [aria-modal="true"]') !== null

function SettingsScreen(): React.JSX.Element | null {
  const { t } = useTranslation()
  const requested = useApp((s) => s.settingsSection)
  const setSection = useApp((s) => s.setSettingsSection)
  const close = useApp((s) => s.closeSettings)
  const sections = useMemo(() => visibleSettingsSections(), [])
  const section = resolveSettingsSection(requested, sections)
  const scrollRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLDivElement>(null)

  // Focus the current nav item on open; give focus back to where it was on close.
  useEffect(() => {
    const previous = document.activeElement
    navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || escapeOwnedAbove()) return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  // Each page starts at its top.
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [section?.id])

  if (!section) return null
  const Content = section.component

  return (
    <div
      role="region"
      aria-label={t('settings.title')}
      className="animate-screen-in fixed inset-0 z-40 flex bg-bg"
    >
      <div
        ref={navRef}
        className="flex w-[240px] shrink-0 flex-col border-r border-border bg-panel"
      >
        {/* Title strip: room for the macOS traffic lights; drags the window. */}
        <div className="drag h-11 shrink-0" />
        <SettingsNav sections={sections} active={section.id} onSelect={setSection} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="drag h-11 shrink-0" />
        <div ref={scrollRef} className="scroll-area min-h-0 flex-1 overflow-y-auto">
          <div className="flex justify-center gap-6 px-10 pb-16 pt-4">
            <main aria-labelledby="settings-page-title" className="w-full min-w-0 max-w-[640px]">
              <header className="mb-6 border-b border-border pb-5">
                <h1 id="settings-page-title" className="text-[20px] font-semibold tracking-tight">
                  {t(section.labelKey)}
                </h1>
                {section.descriptionKey && (
                  <p className="mt-1.5 max-w-prose leading-relaxed text-muted">
                    {t(section.descriptionKey)}
                  </p>
                )}
              </header>
              {/*
               * Sections render only their controls. Older ones carry their own <section> and
               * heading from the dialog days; the page title above replaces that heading.
               */}
              <div
                key={section.id}
                className="animate-fade-up [&>section:first-child]:mt-0 [&>section:first-child>h3:first-child]:hidden"
              >
                <Content />
              </div>
            </main>
            <div className="sticky top-0 flex shrink-0 flex-col items-center gap-1.5 self-start">
              <button
                type="button"
                aria-label={t('settings.close')}
                data-tooltip={t('settings.close')}
                aria-keyshortcuts="Escape"
                onClick={close}
                className="no-drag flex size-9 items-center justify-center rounded-full border border-border bg-elevated text-muted transition-colors hover:border-fg/30 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
              >
                <X size={16} aria-hidden />
              </button>
              <span aria-hidden className="text-[11px] font-semibold tracking-wide text-muted">
                ESC
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
