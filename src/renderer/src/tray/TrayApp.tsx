import { AppWindow, Power } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { applyLanguage, useApp } from '../store'
import { TooltipLayer } from '../ui/TooltipLayer'
import { UsageDetailsContent } from '../usage/UsageDetails'
import { useUsage } from '../usage/usageStore'

/** Compact usage view shown in the macOS menu bar popover window. */
export function TrayApp(): React.JSX.Element {
  const { t } = useTranslation()
  const ready = useApp((s) => s.data !== null)
  const hasAccounts = useApp((s) => (s.data?.accounts.length ?? 0) > 0)
  const accountId = useApp((s) => s.selectedAccountId)
  // Bumped each time the popover opens, so it starts on the menu bar's account again.
  const [shown, setShown] = useState(0)

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const [data, trayAccount] = await Promise.all([
          window.api.state.get(),
          window.api.app.trayAccount()
        ])
        applyLanguage(data)
        useApp.setState({ data, selectedAccountId: trayAccount ?? data.accounts[0]?.id ?? null })
        setShown((n) => n + 1)
      } catch {
        // The main process answers once it is ready; the next open tries again.
      }
    }
    // The first open loads here; later opens of the same window are announced by the main process.
    void load()
    const offShown = window.api.app.onTrayShown(() => void load())
    const offState = window.api.state.onChanged((data) => {
      applyLanguage(data)
      useApp.setState({ data })
    })
    return () => {
      offShown()
      offState()
    }
  }, [])

  useEffect(() => {
    const { hydrate, subscribe } = useUsage.getState()
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [])

  const rootRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  useFitWindow(rootRef, contentRef, ready && hasAccounts, `${accountId}:${shown}`)

  if (!ready) return <div className="h-full bg-elevated" />

  return (
    <div ref={rootRef} className="flex h-full flex-col overflow-hidden bg-elevated text-fg">
      {hasAccounts ? (
        <UsageDetailsContent key={`${accountId}:${shown}`} contentRef={contentRef} />
      ) : (
        <p className="flex-1 px-4 py-6 text-[12px] leading-snug text-muted">
          {t('tray.noAccounts')}
        </p>
      )}
      <nav className="flex items-center justify-between gap-2 border-t border-border px-2 py-1.5">
        <TrayButton onClick={() => void window.api.app.openMain()}>
          <AppWindow size={14} aria-hidden />
          {t('tray.open')}
        </TrayButton>
        <TrayButton onClick={() => void window.api.app.quit()}>
          <Power size={14} aria-hidden />
          {t('tray.quit')}
        </TrayButton>
      </nav>
      <TooltipLayer />
    </div>
  )
}

/**
 * Asks the main process for a window height that shows the whole content without a gap:
 * everything around the scroll area plus the content's own height. The main process clamps it
 * and the content scrolls when the screen is too short.
 */
function useFitWindow(
  rootRef: React.RefObject<HTMLDivElement | null>,
  contentRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
  /** Changes whenever the content remounts, so the observer follows the new element. */
  mount: string
): void {
  useLayoutEffect(() => {
    const root = rootRef.current
    const content = contentRef.current
    const scroller = content?.parentElement
    if (!active || !root || !content || !scroller) return
    let sent = 0
    const measure = (): void => {
      const height = Math.ceil(root.offsetHeight - scroller.clientHeight + content.offsetHeight)
      if (height === sent) return
      sent = height
      window.api.app.resizeTray(height)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    observer.observe(content)
    measure()
    return () => observer.disconnect()
  }, [rootRef, contentRef, active, mount])
}

function TrayButton({
  onClick,
  children
}: {
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted transition-colors hover:bg-fg/[0.06] hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
      onClick={onClick}
    >
      {children}
    </button>
  )
}
