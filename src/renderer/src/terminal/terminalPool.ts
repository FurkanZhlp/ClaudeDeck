import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { isWindows, primaryModifier } from '../platform'

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

// Kept on globalThis so a hot reload of this module in development reuses the live terminals.
const globalPool = globalThis as typeof globalThis & { __claudedeckTerminals?: Map<string, Entry> }
const entries = (globalPool.__claudedeckTerminals ??= new Map<string, Entry>())

function create(id: string): Entry {
  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Mono", Consolas, monospace',
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
  // Yanlışlıkla tıklamayı önlemek için linkler yalnızca Cmd+tık (Windows'ta Ctrl+tık) ile açılır.
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (primaryModifier(event)) window.open(uri)
    })
  )
  if (isWindows) term.attachCustomKeyEventHandler((event) => windowsClipboardKeys(term, event))
  term.onData((data) => window.api.pty.write(id, data))
  const host = document.createElement('div')
  host.style.width = '100%'
  host.style.height = '100%'
  const entry: Entry = { term, fit, host, opened: false, pending: null }
  entries.set(id, entry)
  return entry
}

/**
 * Windows terminal clipboard keys (there is no app menu to provide them): Ctrl+C copies when text
 * is selected and otherwise reaches the program as SIGINT; Ctrl+V pastes; Ctrl+Shift+C always
 * copies and Ctrl+Shift+V pastes. Returns false for keys handled here so xterm does not also send them.
 */
function windowsClipboardKeys(term: Terminal, event: KeyboardEvent): boolean {
  if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return true
  const key = event.key.toLowerCase()
  if (key === 'c' && (event.shiftKey || term.hasSelection())) {
    event.preventDefault()
    const text = term.getSelection()
    if (text) void navigator.clipboard.writeText(text).catch(() => undefined)
    term.clearSelection()
    return false
  }
  // Ctrl+V and Ctrl+Shift+V: let the browser's native paste reach xterm's textarea (xterm pastes
  // with bracketed paste support), instead of xterm sending ^V. No clipboard read permission.
  if (key === 'v') return false
  return true
}

/**
 * Draws the terminal on the GPU. xterm's default DOM renderer rebuilds row elements on every
 * scroll, which stutters with a long scrollback. Falls back to the DOM renderer when WebGL is
 * unavailable or its context is lost (for example after the GPU process restarts).
 */
function enableWebgl(term: Terminal): void {
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => webgl.dispose())
    term.loadAddon(webgl)
  } catch (error) {
    console.warn('[terminal] WebGL renderer unavailable, using the DOM renderer', error)
  }
}

function ensure(id: string): Entry {
  return entries.get(id) ?? create(id)
}

/** Creates the terminal up front so output is kept even before it is first shown. */
export function prepare(id: string): void {
  ensure(id)
}

export function requestStart(id: string, resume: boolean): void {
  const entry = ensure(id)
  // Önceki süreçten kalan modlar (alternate screen, mouse tracking) yeni sürece taşınmasın.
  if (entry.opened) entry.term.reset()
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
    enableWebgl(entry.term)
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
