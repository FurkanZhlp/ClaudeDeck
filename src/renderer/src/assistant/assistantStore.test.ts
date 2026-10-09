import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantDoneEvent, AssistantProposal, AssistantStatusEvent } from '@shared/assistant'

vi.mock('../store', () => ({
  errorCode: (error: unknown) =>
    error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'UNKNOWN'
}))

const { useAssistant } = await import('./assistantStore')

type Listener<T> = (value: T) => void
const listeners: {
  status?: Listener<AssistantStatusEvent>
  proposal?: Listener<AssistantProposal>
  done?: Listener<AssistantDoneEvent>
} = {}

const api = {
  start: vi.fn(),
  followUp: vi.fn(() => Promise.resolve(null)),
  cancel: vi.fn(() => Promise.resolve(null)),
  apply: vi.fn(),
  reject: vi.fn(() => Promise.resolve(null)),
  undo: vi.fn(() => Promise.resolve({})),
  onStatus: vi.fn((cb: Listener<AssistantStatusEvent>) => {
    listeners.status = cb
    return () => undefined
  }),
  onProposal: vi.fn((cb: Listener<AssistantProposal>) => {
    listeners.proposal = cb
    return () => undefined
  }),
  onQuestion: vi.fn(() => () => undefined),
  onDone: vi.fn((cb: Listener<AssistantDoneEvent>) => {
    listeners.done = cb
    return () => undefined
  }),
  onError: vi.fn(() => () => undefined)
}

const proposal: AssistantProposal = {
  id: 'p1',
  runId: 'r1',
  summary: 'Docker silmelerinde sor',
  reason: 'İstediğiniz gibi.',
  changes: [],
  examples: [],
  risks: [],
  confirmations: ['guardAllow:disk']
}

const storage = new Map<string, string>()

beforeEach(() => {
  vi.clearAllMocks()
  storage.clear()
  ;(globalThis as unknown as { window: unknown }).window = { api: { assistant: api } }
  ;(globalThis as unknown as { localStorage: Partial<Storage> }).localStorage = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => void storage.set(k, v)
  }
  useAssistant.getState().closeWindow()
  useAssistant.getState().subscribe()
})

describe('assistant store', () => {
  it('starts a run pre-scoped to the section and remembers the account', async () => {
    api.start.mockResolvedValue({ runId: 'r1' })
    useAssistant.getState().openWindow({ section: 'guard' })
    await useAssistant.getState().start('Docker silmelerinde sor', 'a2', 'p9')
    expect(api.start).toHaveBeenCalledWith({
      prompt: 'Docker silmelerinde sor',
      accountId: 'a2',
      section: 'guard',
      projectId: 'p9'
    })
    expect(storage.get('claudedeck.assistant.account')).toBe('a2')
    expect(useAssistant.getState()).toMatchObject({
      runId: 'r1',
      view: { step: 'working', phase: 'starting' },
      busy: false
    })
    listeners.status?.({ runId: 'r1', phase: 'testing' })
    expect(useAssistant.getState().view).toEqual({ step: 'working', phase: 'testing' })
    listeners.proposal?.(proposal)
    expect(useAssistant.getState().view).toEqual({ step: 'proposal', proposal })
  })

  it('shows a start error as an error step', async () => {
    api.start.mockRejectedValue(new Error('CLAUDE_NOT_FOUND'))
    useAssistant.getState().openWindow()
    await useAssistant.getState().start('x', 'a1')
    expect(useAssistant.getState().view).toEqual({
      step: 'error',
      code: 'CLAUDE_NOT_FOUND',
      detail: null
    })
  })

  it('applies with the accepted confirmations and closes without cancelling', async () => {
    api.start.mockResolvedValue({ runId: 'r1' })
    api.apply.mockResolvedValue({ undoToken: 'u1', section: 'guard', keys: [], state: {} })
    useAssistant.getState().openWindow({ section: 'guard' })
    await useAssistant.getState().start('x', 'a1')
    listeners.proposal?.(proposal)
    const result = await useAssistant.getState().apply(['guardAllow:disk'])
    expect(api.apply).toHaveBeenCalledWith('p1', ['guardAllow:disk'])
    expect(result).toMatchObject({ undoToken: 'u1' })
    expect(useAssistant.getState().open).toBe(false)
    expect(api.cancel).not.toHaveBeenCalled()
  })

  it('a follow-up goes back to working; closing cancels the open run', async () => {
    api.start.mockResolvedValue({ runId: 'r1' })
    useAssistant.getState().openWindow()
    await useAssistant.getState().start('x', 'a1')
    listeners.done?.({ runId: 'r1', outcome: 'answered', message: 'Bunu yapamam.' })
    expect(useAssistant.getState().view).toEqual({ step: 'answered', message: 'Bunu yapamam.' })
    expect(await useAssistant.getState().followUp('O zaman şunu yap')).toBe(true)
    expect(api.followUp).toHaveBeenCalledWith('r1', 'O zaman şunu yap')
    expect(useAssistant.getState().view).toEqual({ step: 'working', phase: 'thinking' })
    useAssistant.getState().closeWindow()
    expect(api.cancel).toHaveBeenCalledWith('r1')
    expect(useAssistant.getState()).toMatchObject({ open: false, runId: null })
  })

  it('declining rejects the proposal and closes the window', async () => {
    api.start.mockResolvedValue({ runId: 'r1' })
    useAssistant.getState().openWindow()
    await useAssistant.getState().start('x', 'a1')
    listeners.proposal?.(proposal)
    await useAssistant.getState().reject()
    expect(api.reject).toHaveBeenCalledWith('p1')
    expect(api.cancel).not.toHaveBeenCalled()
    expect(useAssistant.getState().open).toBe(false)
  })

  it('closing while the start is in flight cancels the new run', async () => {
    let resolve!: (v: { runId: string }) => void
    api.start.mockReturnValue(new Promise((r) => (resolve = r)))
    useAssistant.getState().openWindow()
    const starting = useAssistant.getState().start('x', 'a1')
    useAssistant.getState().closeWindow()
    resolve({ runId: 'r7' })
    await starting
    expect(api.cancel).toHaveBeenCalledWith('r7')
  })
})
