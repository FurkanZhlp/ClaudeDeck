import type { BrowserWindowConstructorOptions, TitleBarOverlay } from 'electron'

/** Height of the renderer's title strip (Tailwind `h-11`); the Windows caption buttons match it. */
export const TITLE_BAR_HEIGHT = 44

/**
 * Mirrors the renderer tokens in `assets/main.css`: the caption buttons sit on the tab strip
 * (`--panel`), draw in the text colour (`--fg`) and the window starts in `--bg`.
 */
const THEME = {
  light: { strip: '#efeeea', symbol: '#1d1d1b', background: '#f7f7f5' },
  dark: { strip: '#141413', symbol: '#ecebe6', background: '#1a1a18' }
} as const

const palette = (dark: boolean): (typeof THEME)[keyof typeof THEME] =>
  dark ? THEME.dark : THEME.light

/** Windows caption button overlay for the current light or dark appearance. */
export function titleBarOverlay(dark: boolean): TitleBarOverlay {
  const { strip, symbol } = palette(dark)
  return { color: strip, symbolColor: symbol, height: TITLE_BAR_HEIGHT }
}

/** Window background matching the renderer, so the first paint is not a white flash. */
export const windowBackground = (dark: boolean): string => palette(dark).background

/**
 * Title bar options per platform. Windows hides the native title bar and keeps its caption
 * buttons as an overlay on the renderer's title strip; macOS (and anything else) keeps the
 * inset traffic lights exactly as before.
 */
export function windowChrome(
  platform: NodeJS.Platform,
  dark: boolean
): Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition' | 'backgroundColor'
> {
  if (platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: titleBarOverlay(dark),
      backgroundColor: windowBackground(dark)
    }
  }
  return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
}
