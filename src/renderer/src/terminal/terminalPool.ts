import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

/** Her oturumun xterm örneği burada yaşar; görünüm değişince yalnızca DOM'a takılıp çıkarılır. */
interface Entry {
  term: Terminal
  fit: FitAddon
  host: HTMLDivElement
  opened: boolean
  pending: { resume: boolean } | null
}

const THEME: ITheme = {
  background: '#141413',
  foreground: '#ecebe6',
  cursor: '#d97757',
  cursorAccent: '#141413',
  selectionBackground: '#d9775755'
}

const entries = new Map<string, Entry>()

function create(id: string): Entry {
  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, Monaco, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 10_000,
    // Türkçe Q klavyede @ gibi karakterler Option ile yazılır; Meta'ya çevirme.
    macOptionIsMeta: false,
    theme: THEME
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)))
  term.onData((data) => window.api.pty.write(id, data))
  const host = document.createElement('div')
  host.style.width = '100%'
  host.style.height = '100%'
  const entry: Entry = { term, fit, host, opened: false, pending: null }
  entries.set(id, entry)
  return entry
}

function ensure(id: string): Entry {
  return entries.get(id) ?? create(id)
}

export function requestStart(id: string, resume: boolean): void {
  const entry = ensure(id)
  if (entry.opened) entry.term.write('\r\n')
  entry.pending = { resume }
}

export function takePending(id: string): { resume: boolean } | null {
  const entry = entries.get(id)
  if (!entry?.pending) return null
  const pending = entry.pending
  entry.pending = null
  return pending
}

export function attach(id: string, container: HTMLElement): void {
  const entry = ensure(id)
  if (entry.host.parentElement !== container) container.appendChild(entry.host)
  if (!entry.opened) {
    entry.term.open(entry.host)
    entry.opened = true
  }
}

export function detach(id: string): void {
  entries.get(id)?.host.remove()
}

export function fit(id: string): { cols: number; rows: number } | null {
  const entry = entries.get(id)
  if (!entry?.opened || !entry.host.isConnected) return null
  try {
    entry.fit.fit()
  } catch {
    return null
  }
  return { cols: entry.term.cols, rows: entry.term.rows }
}

export function focus(id: string): void {
  entries.get(id)?.term.focus()
}

export function write(id: string, data: string): void {
  entries.get(id)?.term.write(data)
}

export function dispose(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  entry.term.dispose()
  entry.host.remove()
  entries.delete(id)
}
