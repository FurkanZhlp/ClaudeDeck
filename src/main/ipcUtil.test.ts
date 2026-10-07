import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: never) => handlers.set(channel, fn) }
}))

const { createIpcTools } = await import('./ipcUtil')

interface FakeContents {
  mainFrame: object
  isDestroyed: () => boolean
}
const contents = (): FakeContents => ({ mainFrame: {}, isDestroyed: () => false })
const event = (sender: FakeContents, frame: object | null = sender.mainFrame): unknown => ({
  sender,
  senderFrame: frame
})

describe('createIpcTools', () => {
  const main = contents()
  const tray = contents()
  const stranger = contents()
  let tools: ReturnType<typeof createIpcTools>

  beforeEach(() => {
    handlers.clear()
    tools = createIpcTools({
      main: () => main as never,
      tray: () => tray as never,
      trayChannels: new Set(['open'])
    })
    tools.handle('open', () => 'ok')
    tools.handle('closed', () => 'ok')
  })

  const call = (channel: string, e: unknown): Promise<unknown> => handlers.get(channel)!(e)
  const denied = { ok: false, code: 'UNKNOWN' }

  it('lets the main window call every channel', async () => {
    expect(await call('open', event(main))).toEqual({ ok: true, data: 'ok' })
    expect(await call('closed', event(main))).toEqual({ ok: true, data: 'ok' })
  })

  it('limits the popover to its allowlist', async () => {
    expect(await call('open', event(tray))).toEqual({ ok: true, data: 'ok' })
    expect(await call('closed', event(tray))).toEqual(denied)
  })

  it('rejects other renderers, subframes and missing frames', async () => {
    expect(await call('open', event(stranger))).toEqual(denied)
    expect(await call('open', event(main, {}))).toEqual(denied)
    expect(await call('open', event(main, null))).toEqual(denied)
  })

  it('trusts only the main window top frame for send channels', () => {
    expect(tools.trusted(event(main) as never)).toBe(true)
    expect(tools.trusted(event(tray) as never)).toBe(false)
    expect(tools.trusted(event(main, {}) as never)).toBe(false)
  })
})
