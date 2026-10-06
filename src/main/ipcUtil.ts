import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { DomainError } from '../shared/errors'
import type { IpcResult } from '../shared/ipc'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (...args: any[]) => unknown

export interface IpcTools {
  /** Registers an invoke handler wrapped in the IpcResult envelope, for the app window only. */
  handle: (channel: string, fn: Handler) => void
  /** True when the event comes from the app's own window. */
  trusted: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean
}

export function createIpcTools(getWindow: () => BrowserWindow | null): IpcTools {
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    event.sender === getWindow()?.webContents

  const handle = (channel: string, fn: Handler): void => {
    ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
      if (!trusted(event)) return { ok: false, code: 'UNKNOWN' }
      try {
        return { ok: true, data: await fn(...args) }
      } catch (error) {
        if (error instanceof DomainError) return { ok: false, code: error.code }
        console.error(`[ipc] ${channel}`, error)
        return { ok: false, code: 'UNKNOWN' }
      }
    })
  }

  return { handle, trusted }
}

export const isText = (v: unknown): v is string => typeof v === 'string'
export const isSize = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0
