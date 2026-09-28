import { useEffect, type RefObject } from 'react'

/** How tall a message may stand in the Terminal view before it scrolls inside
 *  its own box. A message taller than the pane cannot be pinned (it would
 *  cover the answer under it, and its lower half could never be read while it
 *  sticks), so every message is capped: by default at a share of the
 *  transcript's height, moved by the grip on a long message's bottom edge, and
 *  never past MAX_SHARE, so an answer always has room under a pinned
 *  question. The cap is the reader's, one for every message, and kept as a
 *  share of the pane, so it means the same in a split pane and a full one.
 *
 *  The stylesheet reads `--term-question-max` on the scroller; a row whose
 *  message is taller than the smallest cap carries `data-tall`, which is what
 *  shows its grip: below that, dragging could change nothing. */
const HEIGHT_KEY = 'clave-terminal-question-height'
export const DEFAULT_SHARE = 0.4
export const MAX_SHARE = 0.75
/** The smallest cap, whatever the pane: six lines of a message and its padding. */
export const MIN_CAP = 152

/** The cap in pixels for a share of a pane this tall. */
export function capFor(share: number, paneHeight: number): number {
  const max = Math.max(MIN_CAP, paneHeight * MAX_SHARE)
  return Math.round(Math.min(max, Math.max(MIN_CAP, share * paneHeight)))
}

function storedShare(): number {
  const value = Number.parseFloat(localStorage.getItem(HEIGHT_KEY) ?? '')
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : DEFAULT_SHARE
}

export function useQuestionHeight(scroll: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = scroll.current
    if (!root) return
    let share = storedShare()
    const messages = (): HTMLElement[] =>
      Array.from(root.querySelectorAll<HTMLElement>('.term-question > .chat-turn'))
    const apply = (cap: number): void => root.style.setProperty('--term-question-max', `${cap}px`)
    const measure = (): void => {
      apply(capFor(share, root.clientHeight))
      for (const message of messages()) {
        const row = message.closest<HTMLElement>('.chat-turn-wrap')
        if (!row) continue
        if (message.scrollHeight > MIN_CAP + 1) row.dataset.tall = 'true'
        else delete row.dataset.tall
      }
    }
    let frame = 0
    const schedule = (): void => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0
          measure()
        })
    }
    // Drag: the cap follows the pointer from where it was, kept on release.
    let drag: { id: number; y: number; cap: number; row: HTMLElement } | null = null
    const onDown = (event: PointerEvent): void => {
      const grip = (event.target as Element).closest<HTMLElement>('.term-question-grip')
      const row = grip?.closest<HTMLElement>('.chat-turn-wrap')
      if (!grip || !row || event.button !== 0) return
      event.preventDefault()
      grip.setPointerCapture(event.pointerId)
      drag = {
        id: event.pointerId,
        y: event.clientY,
        cap: capFor(share, root.clientHeight),
        row
      }
      row.dataset.resizing = 'true'
    }
    const onMove = (event: PointerEvent): void => {
      if (!drag || event.pointerId !== drag.id) return
      const pane = root.clientHeight
      const cap = capFor((drag.cap + event.clientY - drag.y) / pane, pane)
      share = cap / pane
      apply(cap)
    }
    const onUp = (event: PointerEvent): void => {
      if (!drag || event.pointerId !== drag.id) return
      delete drag.row.dataset.resizing
      drag = null
      localStorage.setItem(HEIGHT_KEY, String(share))
    }
    const onDoubleClick = (event: MouseEvent): void => {
      if (!(event.target as Element).closest('.term-question-grip')) return
      share = DEFAULT_SHARE
      localStorage.removeItem(HEIGHT_KEY)
      measure()
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(root)
    // New exchanges, pages of the past arriving in front, and rows the
    // virtualiser mounts as they near the viewport (rows.tsx).
    const mutations = new MutationObserver(schedule)
    const box = root.querySelector('.chat-rows') ?? root.firstElementChild
    if (box) mutations.observe(box, { childList: true })
    root.addEventListener('pointerdown', onDown)
    root.addEventListener('pointermove', onMove)
    root.addEventListener('pointerup', onUp)
    root.addEventListener('pointercancel', onUp)
    root.addEventListener('dblclick', onDoubleClick)
    measure()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
      root.removeEventListener('pointerdown', onDown)
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerup', onUp)
      root.removeEventListener('pointercancel', onUp)
      root.removeEventListener('dblclick', onDoubleClick)
      root.style.removeProperty('--term-question-max')
    }
  }, [scroll])
}
