import { mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import type { Account } from '../../shared/types'
import { statuslineScriptPath, usageRawPath } from './statusline'
import { createUsageService, type UsageService } from './usageWatcher'

const root = (): string => mkdtempSync(join(tmpdir(), 'claudedeck-usage-watch-'))

const account = (base: string, id: string): Account => ({
  id,
  name: id,
  color: '#000',
  configDir: join(base, 'accounts', id)
})

const reading = (used: number): string =>
  JSON.stringify({
    session_id: 's',
    rate_limits: {
      five_hour: { used_percentage: used, resets_at: 1791329400 },
      seven_day: { used_percentage: 60, resets_at: 1791507600 }
    }
  })

/** Writes like the statusline script: temp file, then rename. */
const writeReading = (configDir: string, text: string): void => {
  const file = usageRawPath(configDir)
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
}

// FSEvents streams start asynchronously; writes in the first moments can go unseen.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let service: UsageService | null = null
afterEach(() => {
  service?.dispose()
  service = null
})

describe('createUsageService', () => {
  it('installs the hook and reports new readings', async () => {
    const base = root()
    const a = account(base, 'a')
    const accounts = [a]
    const send = vi.fn()
    service = createUsageService({ repo: { get: () => ({ accounts }) }, userDataDir: base, send })
    service.prepareAccount(a)

    const settings = JSON.parse(readFileSync(join(a.configDir, 'settings.json'), 'utf8'))
    expect(settings.statusLine.command).toContain(statuslineScriptPath(a.configDir))
    expect(send).not.toHaveBeenCalled()

    await settle()
    writeReading(a.configDir, reading(29))
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { timeout: 3000 })
    const [channel, usage] = send.mock.calls[0]
    expect(channel).toBe(IPC.usageUpdate)
    expect(usage).toMatchObject({
      accountId: 'a',
      fiveHour: { usedPercentage: 29, resetsAt: 1791329400000 },
      sevenDay: { usedPercentage: 60 }
    })
    expect(service.list()).toEqual([usage])

    // Persisted for the next start.
    const stored = JSON.parse(readFileSync(join(base, 'usage.json'), 'utf8'))
    expect(stored.accounts).toEqual([usage])
  })

  it('reads an existing file on prepare and restores stored usage after restart', async () => {
    const base = root()
    const a = account(base, 'a')
    const accounts = [a]
    const first = createUsageService({
      repo: { get: () => ({ accounts }) },
      userDataDir: base,
      send: vi.fn()
    })
    first.prepareAccount(a)
    writeReading(a.configDir, reading(40))
    first.dispose()

    const send = vi.fn()
    service = createUsageService({ repo: { get: () => ({ accounts }) }, userDataDir: base, send })
    service.prepareAccount(a)
    expect(send).toHaveBeenCalledTimes(1)
    expect(service.list()[0]?.fiveHour?.usedPercentage).toBe(40)

    // Same file again: nothing new to report.
    service.prepareAccount(a)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('retries once when it catches a partial write', async () => {
    const base = root()
    const a = account(base, 'a')
    const send = vi.fn()
    service = createUsageService({
      repo: { get: () => ({ accounts: [a] }) },
      userDataDir: base,
      send
    })
    service.prepareAccount(a)
    await settle()
    writeFileSync(usageRawPath(a.configDir), reading(50).slice(0, 20))
    await sleep(230)
    writeFileSync(usageRawPath(a.configDir), reading(50))
    await vi.waitFor(() => expect(send).toHaveBeenCalled(), { timeout: 3000 })
    expect(send.mock.calls.at(-1)?.[1].fiveHour.usedPercentage).toBe(50)
  })

  it('ignores readings without rate limits', async () => {
    const base = root()
    const a = account(base, 'a')
    const send = vi.fn()
    service = createUsageService({
      repo: { get: () => ({ accounts: [a] }) },
      userDataDir: base,
      send
    })
    service.prepareAccount(a)
    await settle()
    writeReading(a.configDir, JSON.stringify({ session_id: 'x' }))
    await sleep(400)
    expect(send).not.toHaveBeenCalled()
    expect(service.list()).toEqual([])
  })

  it('stops watching and forgets removed accounts', async () => {
    const base = root()
    const a = account(base, 'a')
    const b = account(base, 'b')
    let accounts = [a, b]
    const send = vi.fn()
    service = createUsageService({ repo: { get: () => ({ accounts }) }, userDataDir: base, send })
    service.prepareAccount(a)
    service.prepareAccount(b)
    await settle()
    writeReading(a.configDir, reading(10))
    await vi.waitFor(() => expect(service?.list()).toHaveLength(1), { timeout: 3000 })

    accounts = [b]
    service.prepareAccount(b)
    expect(service.list()).toEqual([])
    send.mockClear()
    writeReading(a.configDir, reading(20))
    await sleep(400)
    expect(send).not.toHaveBeenCalled()
  })

  it('ingests polled readings, newest first, and only for known accounts', () => {
    const base = root()
    const a = account(base, 'a')
    const send = vi.fn()
    service = createUsageService({
      repo: { get: () => ({ accounts: [a] }) },
      userDataDir: base,
      send
    })
    const polled = {
      accountId: 'a',
      fiveHour: { usedPercentage: 12, resetsAt: 2_000_000 },
      sevenDay: { usedPercentage: 62, resetsAt: 3_000_000 },
      models: [],
      updatedAt: 1000
    }
    service.ingest(polled)
    expect(send).toHaveBeenCalledWith(IPC.usageUpdate, polled)
    service.ingest(polled)
    service.ingest({ ...polled, updatedAt: 500 })
    service.ingest({ ...polled, accountId: 'gone', updatedAt: 2000 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(service.list()).toEqual([polled])
  })

  it('keeps future per-model windows when a statusline reading arrives', async () => {
    const base = root()
    const a = account(base, 'a')
    const send = vi.fn()
    service = createUsageService({
      repo: { get: () => ({ accounts: [a] }) },
      userDataDir: base,
      send,
      now: () => 1_791_000_000_000
    })
    service.ingest({
      accountId: 'a',
      fiveHour: null,
      sevenDay: null,
      models: [
        { model: 'Fable', usedPercentage: 5, resetsAt: 1_791_507_600_000 },
        { model: 'Old', usedPercentage: 90, resetsAt: 1_790_000_000_000 }
      ],
      updatedAt: 1
    })
    service.prepareAccount(a)
    await settle()
    writeReading(a.configDir, reading(33))
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), { timeout: 3000 })
    expect(send.mock.calls[1][1]).toMatchObject({
      fiveHour: { usedPercentage: 33 },
      models: [{ model: 'Fable', usedPercentage: 5, resetsAt: 1_791_507_600_000 }]
    })
  })
})
