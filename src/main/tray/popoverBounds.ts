export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Space kept between the popover and the menu bar icon or the screen edges. */
const MARGIN = 6

/**
 * Popover frame centred under the menu bar icon, kept inside the display's work area and
 * shortened when the screen is too small for the preferred height.
 */
export function popoverBounds(
  tray: Rect,
  workArea: Rect,
  size: { width: number; height: number }
): Rect {
  const width = Math.min(size.width, workArea.width - 2 * MARGIN)
  const minX = workArea.x + MARGIN
  const maxX = workArea.x + workArea.width - width - MARGIN
  const centred = Math.round(tray.x + tray.width / 2 - width / 2)
  const x = Math.max(minX, Math.min(maxX, centred))
  const y = Math.max(workArea.y, tray.y + tray.height) + MARGIN
  const height = Math.min(size.height, workArea.y + workArea.height - y - MARGIN)
  return { x, y, width, height }
}
