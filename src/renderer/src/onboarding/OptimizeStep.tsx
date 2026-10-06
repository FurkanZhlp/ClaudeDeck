import { useEffect } from 'react'
import { isLive, useOptimizeRun } from '../optimize/optimizeStore'
import { OptimizeView } from '../optimize/OptimizeView'
import { useOnboarding } from './onboardingStore'

export function OptimizeStep({ accountId }: { accountId: string }): React.JSX.Element {
  const next = useOnboarding((s) => s.next)
  const setOptimized = useOnboarding((s) => s.setOptimized)
  const showSignIn = useOnboarding((s) => s.showSignIn)
  const run = useOptimizeRun(accountId)
  const ran = run !== undefined && (isLive(run.status) || run.status === 'finished')

  // A run that started (even if it continues in the background) counts as optimized.
  useEffect(() => {
    if (ran) setOptimized()
  }, [ran, setOptimized])

  return <OptimizeView accountId={accountId} onDone={next} onSkip={next} onSignIn={showSignIn} />
}
