import type { OptimizeDecision, OptimizeEvent, OptimizeQuestion } from '@shared/types'

export type FindingsEvent = Extract<OptimizeEvent, { type: 'findings' }>
export type FinishEvent = Extract<OptimizeEvent, { type: 'finish' }>
/** The most recent thing Claude reported: a status line or a tool call. */
export type LiveEvent = Extract<OptimizeEvent, { type: 'status' | 'activity' }>

export interface AnsweredQuestion {
  question: OptimizeQuestion
  decision: OptimizeDecision
  note?: string
}

export interface RunSummary {
  latest: LiveEvent | null
  /** 1-based position of each proposal in the run, by question id. */
  numbers: Record<string, number>
  findings: FindingsEvent | null
  answered: AnsweredQuestion[]
  finish: FinishEvent | null
  error: string | null
}

/** Folds the run's event log into what the view shows. */
export function summarize(events: OptimizeEvent[]): RunSummary {
  const questions = new Map<string, OptimizeQuestion>()
  const summary: RunSummary = {
    latest: null,
    numbers: {},
    findings: null,
    answered: [],
    finish: null,
    error: null
  }
  for (const event of events) {
    switch (event.type) {
      case 'status':
      case 'activity':
        summary.latest = event
        break
      case 'findings':
        summary.findings = event
        break
      case 'question':
        questions.set(event.question.id, event.question)
        summary.numbers[event.question.id] ??= Object.keys(summary.numbers).length + 1
        break
      case 'answer': {
        const question = questions.get(event.answer.questionId)
        if (question) {
          summary.answered.push({
            question,
            decision: event.answer.decision,
            note: event.answer.note
          })
        }
        break
      }
      case 'finish':
        summary.finish = event
        break
      case 'error':
        summary.error = event.message
        break
    }
  }
  return summary
}

/** "1:05" or "1:02:05" for a duration in milliseconds. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`
}
