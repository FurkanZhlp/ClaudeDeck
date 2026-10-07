/** Operating system the app runs on, from the preload; fixed for the life of the page. */
export const platform: NodeJS.Platform = window.api.app.platform
export const isMac = platform === 'darwin'
export const isWindows = platform === 'win32'

/**
 * Profile optimization is available here; the preload derives it from the shared rule the main
 * process enforces (DomainError 'UNSUPPORTED'), so the UI hides its entry points to match.
 */
export const optimizeSupported: boolean = window.api.app.optimizeSupported

/** The platform's primary shortcut modifier is held: Cmd on macOS, Ctrl elsewhere. */
export const primaryModifier = (event: { metaKey: boolean; ctrlKey: boolean }): boolean =>
  isMac ? event.metaKey : event.ctrlKey

/**
 * Marks the document (`<html data-platform>`) before the first render, so CSS can reserve room
 * for the Windows caption buttons from the first frame.
 */
export function markPlatform(): void {
  document.documentElement.dataset.platform = platform
}
