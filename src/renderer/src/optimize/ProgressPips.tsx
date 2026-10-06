import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { OptimizeDecision } from '@shared/types'
import { plainText } from './friendly'
import { popVariants } from './motionPresets'
import type { AnsweredQuestion } from './runEvents'

/** Filled for applied or changed proposals, hollow for skipped ones. */
const PIP: Record<OptimizeDecision, string> = {
  apply: 'bg-accent',
  modify: 'bg-accent',
  skip: 'border-[1.5px] border-muted/60'
}

/** Answered proposals as a tiny row of pips with tooltips; nothing when there are none. */
export function ProgressPips({ items }: { items: AnsweredQuestion[] }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (items.length === 0) return null
  return (
    <ol aria-label={t('optimize.history.title')} className="flex items-center gap-1.5">
      {items.map(({ question, decision, note }) => {
        const label = `${t(`optimize.history.decision.${decision}`)}: ${plainText(question.title)}`
        const tip = note ? `${label} · ${note}` : label
        return (
          <motion.li
            key={question.id}
            variants={popVariants}
            initial="initial"
            animate="animate"
            tabIndex={0}
            aria-label={tip}
            data-tooltip={tip}
            className="flex size-4 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span aria-hidden className={`block size-2 rounded-full ${PIP[decision]}`} />
          </motion.li>
        )
      })}
    </ol>
  )
}
