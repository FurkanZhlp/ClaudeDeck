import type { Transition, Variants } from 'motion/react'

/** Soft, slightly damped spring for the proposal and pop-ins. */
export const SPRING: Transition = { type: 'spring', stiffness: 300, damping: 32, mass: 0.9 }

/** Ease-out used for fades and small slides (no linear, no overshoot). */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const
export const EASE_IN = [0.4, 0, 1, 1] as const

export const FADE_S = 0.32
export const EXIT_S = 0.22

/** A whole moment of the run screen (thinking, findings, result): fade with a small rise. */
export const momentVariants: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: FADE_S, ease: EASE_OUT } },
  exit: { opacity: 0, y: -8, transition: { duration: EXIT_S, ease: EASE_IN } }
}

/** The proposal enters from the bottom on a spring and leaves downward. */
export const proposalVariants: Variants = {
  initial: { opacity: 0, y: 96 },
  animate: { opacity: 1, y: 0, transition: SPRING },
  exit: { opacity: 0, y: 72, transition: { duration: EXIT_S, ease: EASE_IN } }
}

/** One changing line (status, finding): slides up in, fades up out. */
export const lineVariants: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: FADE_S, ease: EASE_OUT } },
  exit: { opacity: 0, y: -8, transition: { duration: EXIT_S * 0.8, ease: EASE_IN } }
}

/** A disclosure body that fades in under its toggle. */
export const revealVariants: Variants = {
  initial: { opacity: 0, y: -4 },
  animate: { opacity: 1, y: 0, transition: { duration: FADE_S, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: EXIT_S * 0.6 } }
}

/** Icon pop for results and progress pips. */
export const popVariants: Variants = {
  initial: { opacity: 0, scale: 0.5 },
  animate: { opacity: 1, scale: 1, transition: SPRING }
}
