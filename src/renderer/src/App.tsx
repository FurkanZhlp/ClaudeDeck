import { useEffect } from 'react'
import { ClaudeBanner } from './components/ClaudeBanner'
import { ErrorToast } from './components/ErrorToast'
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
    void init()
  }, [init])

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
      <ErrorToast />
      <TooltipLayer />
    </div>
  )
}
