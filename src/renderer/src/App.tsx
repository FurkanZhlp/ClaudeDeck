import { useEffect } from 'react'
import { ClaudeBanner } from './components/ClaudeBanner'
import { ErrorToast } from './components/ErrorToast'
import { NoticeToast } from './components/NoticeToast'
import { OnboardingFlow } from './onboarding/OnboardingFlow'
import { useOnboarding } from './onboarding/onboardingStore'
import { useOptimize } from './optimize/optimizeStore'
import { LoginDialog } from './components/LoginDialog'
import { ProjectDialog } from './components/ProjectDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { UpdateBanner } from './components/UpdateBanner'
import { TooltipLayer } from './ui/TooltipLayer'
import { Workspace } from './components/Workspace'
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

  if (!ready) return <div className="drag h-full" />

  return (
    <div
      className="flex h-full"
      style={accent ? ({ '--account': accent } as React.CSSProperties) : undefined}
    >
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <UpdateBanner />
        <ClaudeBanner />
        <Workspace />
      </main>
      <ProjectDialog />
      <SettingsDialog />
      <LoginDialog />
      <OnboardingFlow />
      <ErrorToast />
      <NoticeToast />
      <TooltipLayer />
    </div>
  )
}
