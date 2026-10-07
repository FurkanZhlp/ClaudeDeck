/*
 * Overlay-style scrollbars (see main.css) show their thumb only while the scroll area is
 * hovered or scrolling. Chromium does not restyle custom scrollbar parts when the element's
 * :hover state changes, but it does when a class changes, so both states are tracked here.
 */

const HOVER_CLASS = 'scrollbar-hover'
const ACTIVE_CLASS = 'scrollbar-active'
/** The thumb stays visible this long after the last scroll event. */
const ACTIVE_FOR_MS = 900

const SCROLLABLE = /(auto|scroll|overlay)/

/** xterm draws its own scrollbar; its elements are left alone. */
const outsideTerminal = (el: Element): boolean => el.closest('.xterm') === null

function scrollableAncestors(start: EventTarget | null): Element[] {
  const result: Element[] = []
  let el = start instanceof Element ? start : null
  for (; el && el !== document.documentElement; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) continue
    const style = getComputedStyle(el)
    if (SCROLLABLE.test(style.overflowY) || SCROLLABLE.test(style.overflowX)) result.push(el)
  }
  return result.filter(outsideTerminal)
}

/** Installs the document-wide listeners once; returns the cleanup. */
export function installScrollbarVisibility(): () => void {
  const timers = new Map<Element, number>()
  let hovered: Element[] = []

  const onScroll = (event: Event): void => {
    const el = event.target
    if (!(el instanceof Element) || !outsideTerminal(el)) return
    el.classList.add(ACTIVE_CLASS)
    window.clearTimeout(timers.get(el))
    timers.set(
      el,
      window.setTimeout(() => {
        el.classList.remove(ACTIVE_CLASS)
        timers.delete(el)
      }, ACTIVE_FOR_MS)
    )
  }

  const setHovered = (next: Element[]): void => {
    hovered.filter((el) => !next.includes(el)).forEach((el) => el.classList.remove(HOVER_CLASS))
    next.forEach((el) => el.classList.add(HOVER_CLASS))
    hovered = next
  }
  const onOver = (event: MouseEvent): void => {
    // Rows under a scrolling terminal fire mouseover constantly; skip the style lookups there.
    if (event.target instanceof Element && !outsideTerminal(event.target)) {
      if (hovered.length > 0) setHovered([])
      return
    }
    setHovered(scrollableAncestors(event.target))
  }
  const onLeave = (): void => setHovered([])

  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  document.addEventListener('mouseover', onOver, { passive: true })
  document.documentElement.addEventListener('mouseleave', onLeave)
  return () => {
    document.removeEventListener('scroll', onScroll, { capture: true })
    document.removeEventListener('mouseover', onOver)
    document.documentElement.removeEventListener('mouseleave', onLeave)
    timers.forEach((timer) => window.clearTimeout(timer))
    timers.clear()
    setHovered([])
  }
}
