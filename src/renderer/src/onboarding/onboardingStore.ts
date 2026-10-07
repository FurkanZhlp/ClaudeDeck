import { create } from 'zustand'
import type { ProfileCategory } from '@shared/types'
import { optimizeSupported } from '../platform'

export type OnboardingStep = 'welcome' | 'account' | 'signIn' | 'import' | 'optimize' | 'done'
export type OnboardingMode = 'firstRun' | 'account'
/** Where an onboarding opened for an existing account begins. */
export type AccountStartStep = 'signIn' | 'import' | 'optimize'

/** Optimize is left out where the main process does not support it (Windows for now). */
const available = (steps: OnboardingStep[]): OnboardingStep[] =>
  optimizeSupported ? steps : steps.filter((step) => step !== 'optimize')

const FIRST_RUN_STEPS = available(['welcome', 'account', 'signIn', 'import', 'optimize', 'done'])
const ACCOUNT_STEPS = available(['signIn', 'import', 'optimize', 'done'])

interface OnboardingStore {
  open: boolean
  mode: OnboardingMode
  accountId: string | null
  step: OnboardingStep
  /** Steps shown in the indicator for this run, in order. */
  steps: OnboardingStep[]
  /** Categories imported during this run; null when the import step was skipped. */
  imported: ProfileCategory[] | null
  optimized: boolean

  startFirstRun: () => void
  startForAccount: (accountId: string, options?: { startAt?: AccountStartStep }) => void
  setAccount: (accountId: string) => void
  setStep: (step: OnboardingStep) => void
  /** Moves to the step after the current one; closes the flow after the last step. */
  next: () => void
  setImported: (categories: ProfileCategory[]) => void
  setOptimized: () => void
  /** Goes to the sign-in step, adding it to this run when it started later. */
  showSignIn: () => void
  close: () => void
}

const fresh = { imported: null, optimized: false }

export const useOnboarding = create<OnboardingStore>((set, get) => ({
  open: false,
  mode: 'firstRun',
  accountId: null,
  step: 'welcome',
  steps: FIRST_RUN_STEPS,
  ...fresh,

  startFirstRun: () =>
    set({
      open: true,
      mode: 'firstRun',
      accountId: null,
      step: 'welcome',
      steps: FIRST_RUN_STEPS,
      ...fresh
    }),

  startForAccount(accountId, options) {
    const requested = options?.startAt ?? 'import'
    const startAt = ACCOUNT_STEPS.includes(requested) ? requested : 'import'
    set({
      open: true,
      mode: 'account',
      accountId,
      step: startAt,
      steps: ACCOUNT_STEPS.slice(ACCOUNT_STEPS.indexOf(startAt)),
      ...fresh
    })
  },

  setAccount: (accountId) => set({ accountId }),
  setStep: (step) => set({ step }),

  next() {
    const { steps, step } = get()
    const following = steps[steps.indexOf(step) + 1]
    if (following) set({ step: following })
    else set({ open: false })
  },

  setImported: (imported) => set({ imported }),
  setOptimized: () => set({ optimized: true }),
  showSignIn() {
    const { steps } = get()
    set({ step: 'signIn', steps: steps.includes('signIn') ? steps : ['signIn', ...steps] })
  },
  close: () => set({ open: false })
}))
