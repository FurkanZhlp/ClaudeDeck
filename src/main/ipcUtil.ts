import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { DomainError } from '../shared/errors'
import type { IpcResult } from '../shared/ipc'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (...args: any[]) => unknown

type IpcEvent = IpcMainEvent | IpcMainInvokeEvent

export interface IpcTools {
  /**
   * Registers an invoke handler wrapped in the IpcResult envelope. Only the main window may call
   * it, plus the menu bar popover when the channel is in the popover's allowlist.
   */
  handle: (channel: string, fn: Handler) => void
  /** True when the event comes from the main window's top frame. */
  trusted: (event: IpcEvent) => boolean
}

export interface IpcSenders {
  /** The main window's renderer; trusted for every channel. */
  main: () => WebContents | null | undefined
  /** The menu bar popover's renderer; trusted only for `trayChannels`. */
  tray: () => WebContents | null | undefined
  /** Invoke channels the popover may call; everything else is main window only. */
  trayChannels: ReadonlySet<string>
}

/** The event comes from `contents` and from its top frame, not an embedded one. */
export function fromTopFrame(event: IpcEvent, contents: WebContents | null | undefined): boolean {
  if (!contents || contents.isDestroyed() || event.sender !== contents) return false
  const frame = event.senderFrame
  return !!frame && frame === contents.mainFrame
}

export function createIpcTools({ main, tray, trayChannels }: IpcSenders): IpcTools {
  const trusted = (event: IpcEvent): boolean => fromTopFrame(event, main())

  const allowed = (channel: string, event: IpcEvent): boolean =>
    trusted(event) || (trayChannels.has(channel) && fromTopFrame(event, tray()))

  const handle = (channel: string, fn: Handler): void => {
    ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
      if (!allowed(channel, event)) return { ok: false, code: 'UNKNOWN' }
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
