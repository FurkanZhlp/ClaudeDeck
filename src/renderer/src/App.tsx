import { useEffect } from 'react'
import { ClaudeBanner } from './components/ClaudeBanner'
import { ErrorToast } from './components/ErrorToast'
import { useGuard } from './guard/guardStore'
import { NoticeToast } from './components/NoticeToast'
import { OnboardingFlow } from './onboarding/OnboardingFlow'
import { useOnboarding } from './onboarding/onboardingStore'
import { useOptimize } from './optimize/optimizeStore'
import { useUsage } from './usage/usageStore'
import { LoginDialog } from './components/LoginDialog'
import { ProjectDialog } from './components/ProjectDialog'
import { Sidebar } from './components/Sidebar'
import { SettingsView } from './settings/SettingsView'
import { UpdateBanner } from './components/UpdateBanner'
import { TooltipLayer } from './ui/TooltipLayer'
import { Workspace } from './components/Workspace'
import { isMac } from './platform'
import { useApp } from './store'

export default function App(): React.JSX.Element {
  const init = useApp((s) => s.init)
  const ready = useApp((s) => s.data !== null)
  const accent = useApp(
    (s) => s.data?.accounts.find((a) => a.id === s.selectedAccountId)?.color ?? null
  )

  useEffect(() => {
    void init().then(() => {
      // First run: no accounts yet, so walk the user through setting one up.
      if (useApp.getState().data?.accounts.length === 0) useOnboarding.getState().startFirstRun()
    })
  }, [init])

  // Optimization runs live in the main process and survive this view; mirror them here.
  useEffect(() => {
    const { hydrate, subscribe } = useOptimize.getState()
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [])

  // Plan usage arrives from each account's statusline hook while Claude runs.
  useEffect(() => {
    const { hydrate, subscribe } = useUsage.getState()
    const unsubscribe = subscribe()
    void hydrate()
    return unsubscribe
  }, [])

  // Command guard decisions feed the activity log; denials show a notice.
  useEffect(() => useGuard.getState().subscribe(), [])

  // The menu bar can follow the account selected here.
  const selectedAccountId = useApp((s) => s.selectedAccountId)
  useEffect(() => {
    window.api.app.setSelectedAccount(selectedAccountId)
  }, [selectedAccountId])

  // Windows has no app menu: Ctrl+, opens Settings here (macOS uses the menu's Cmd+,).
  useEffect(() => {
    if (isMac) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== ',' || !event.ctrlKey || event.altKey || event.shiftKey) return
      event.preventDefault()
      event.stopPropagation()
      useApp.getState().openSettings()
    }
    // Capture phase, so a focused terminal does not receive the key first.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // The settings view covers the workspace; keep the terminals mounted but out of reach.
  const settingsOpen = useApp((s) => s.settingsOpen)

  if (!ready) return <div className="drag h-full" />

  return (
    <div
      className="flex h-full"
      style={accent ? ({ '--account': accent } as React.CSSProperties) : undefined}
    >
      <div className="flex min-w-0 flex-1" inert={settingsOpen}>
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <UpdateBanner />
          <ClaudeBanner />
          <Workspace />
        </main>
      </div>
      <SettingsView />
      <ProjectDialog />
      <LoginDialog />
      <OnboardingFlow />
      <ErrorToast />
      <NoticeToast />
      <TooltipLayer />
    </div>
  )
}
