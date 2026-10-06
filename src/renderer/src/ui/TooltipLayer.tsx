import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Hover delay before the first tooltip; moving to a neighbour while one is shown is instant. */
const SHOW_DELAY_MS = 450
const GAP = 6
const EDGE = 8

interface Tip {
  label: string
  anchor: DOMRect
  side: 'right' | 'auto'
}

/**
 * Single app-wide tooltip. Any element with a `data-tooltip` attribute gets one, so buttons
 * need no wrapper elements that could disturb layout.
 */
export function TooltipLayer(): React.JSX.Element | null {
  const [tip, setTip] = useState<Tip | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let current: HTMLElement | null = null
    let visible = false

    const show = (el: HTMLElement): void => {
      const label = el.dataset.tooltip
      if (!label || !el.isConnected) return
      visible = true
      const side = el.dataset.tooltipSide === 'right' ? 'right' : 'auto'
      setTip({ label, anchor: el.getBoundingClientRect(), side })
    }
    const hide = (): void => {
      clearTimeout(timer)
      current = null
      visible = false
      setTip(null)
    }
    const target = (event: Event): HTMLElement | null =>
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tooltip]') : null

    const onOver = (event: MouseEvent): void => {
      const el = target(event)
      if (el === current) return
      if (!el) return hide()
      clearTimeout(timer)
      current = el
      if (visible) show(el)
      else timer = setTimeout(() => show(el), SHOW_DELAY_MS)
    }
    const onFocusIn = (event: FocusEvent): void => {
      const el = target(event)
      if (el?.matches(':focus-visible')) {
        current = el
        show(el)
      }
    }

    document.addEventListener('mouseover', onOver)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', hide)
    document.addEventListener('mousedown', hide, true)
    document.addEventListener('keydown', hide, true)
    document.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', hide)
      document.removeEventListener('mousedown', hide, true)
      document.removeEventListener('keydown', hide, true)
      document.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  // Measure, then place next to the anchor while staying inside the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!tip || !el) return setPosition(null)
    const { width, height } = el.getBoundingClientRect()
    const { anchor } = tip
    if (tip.side === 'right' && anchor.right + GAP + width <= window.innerWidth - EDGE) {
      const top = Math.min(
        Math.max(anchor.top + anchor.height / 2 - height / 2, EDGE),
        window.innerHeight - height - EDGE
      )
      return setPosition({ left: anchor.right + GAP, top })
    }
    const above = anchor.top - GAP - height >= EDGE
    const left = Math.min(
      Math.max(anchor.left + anchor.width / 2 - width / 2, EDGE),
      window.innerWidth - width - EDGE
    )
    setPosition({ left, top: above ? anchor.top - GAP - height : anchor.bottom + GAP })
  }, [tip])

  if (!tip) return null
  return (
    <div
      ref={ref}
      role="tooltip"
      className="animate-tooltip-in pointer-events-none fixed z-[100] max-w-xs rounded-md bg-fg px-2 py-1 text-[12px] leading-snug text-bg shadow-lg"
      style={position ?? { left: 0, top: 0, visibility: 'hidden' }}
    >
      {tip.label}
    </div>
  )
}
