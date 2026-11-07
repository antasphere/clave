import { useEffect, type RefObject } from 'react'

/** A message in the Enclave view never scrolls inside its own box. A long
 *  one cannot be pinned whole, though: stuck under the top edge it would
 *  cover the answer under it. So a message taller than PIN_SHARE of the
 *  view's height carries `data-tall` on its row, and is pinned only once
 *  read past, as a preview of its first lines (TermQuestion); the row's
 *  `--question-pin-offset` is how far its top rises above the edge first.
 *  The share is of the whole view, composer and cards included, not of the
 *  transcript: a growing draft or a card arriving under the composer must
 *  not flip a message between pinned whole and pinned short. It is still a
 *  share, so it means the same in a split pane and a full one. */
export const PIN_SHARE = 0.3

/** Whether a message this tall is too tall to pin in a pane this tall. */
export function tooTallToPin(messageHeight: number, paneHeight: number): boolean {
  return messageHeight > paneHeight * PIN_SHARE
}

export function useQuestionHeight(
  scroll: RefObject<HTMLElement | null>,
  /** Questions are pinned (the view's toggle): off, nothing is measured and
   *  nothing runs on scroll. */
  enabled: boolean
): void {
  useEffect(() => {
    const root = scroll.current
    if (!root || !enabled) return
    const view = root.closest<HTMLElement>('.chat-view') ?? root
    /** Each long row's sticky top in pixels, resolved once per measure. */
    const tops = new WeakMap<HTMLElement, number>()
    const measure = (): void => {
      const pane = view.clientHeight
      for (const message of root.querySelectorAll<HTMLElement>('.term-question > .chat-turn')) {
        const row = message.closest<HTMLElement>('.chat-turn-wrap')
        if (!row) continue
        if (tooTallToPin(message.offsetHeight, pane)) {
          row.dataset.tall = 'true'
          // How far the row's top rises above the edge before the preview
          // pins: everything but the preview's own height at its foot.
          const pin = row.querySelector<HTMLElement>(':scope > .term-question-pin')
          const offset = row.offsetHeight - (pin?.offsetHeight ?? 0)
          row.style.setProperty('--question-pin-offset', `${offset}px`)
          tops.delete(row)
        } else {
          delete row.dataset.tall
          delete row.dataset.stuck
          row.style.removeProperty('--question-pin-offset')
        }
      }
    }
    // A long message's row is stuck once its sticky top holds it: its box
    // sits at that top, the rest of it risen above the edge. Marked on the
    // row, which is what swaps its foot for the preview.
    // Run on every frame of a scroll, so it reads only positions: each row's
    // sticky top is resolved once, when it is measured (`tops`), never by a
    // style read per frame, and the mark is written only when it changes.
    const stuck = (): void => {
      const edge = root.getBoundingClientRect().top
      for (const row of root.querySelectorAll<HTMLElement>('.chat-turn-wrap[data-tall]')) {
        let top = tops.get(row)
        if (top === undefined) {
          top = parseFloat(getComputedStyle(row).top)
          tops.set(row, top)
        }
        const now = Number.isFinite(top) && row.getBoundingClientRect().top - edge <= top + 0.5
        if (now !== (row.dataset.stuck === 'true')) {
          if (now) row.dataset.stuck = 'true'
          else delete row.dataset.stuck
        }
      }
    }
    let frame = 0
    const schedule = (): void => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0
          measure()
          stuck()
        })
    }
    let scrolled = 0
    const onScroll = (): void => {
      if (!scrolled)
        scrolled = requestAnimationFrame(() => {
          scrolled = 0
          stuck()
        })
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    const resize = new ResizeObserver(schedule)
    resize.observe(view)
    // New exchanges, pages of the past arriving in front, and rows the
    // virtualiser mounts as they near the viewport (rows.tsx).
    const mutations = new MutationObserver(schedule)
    const box = root.querySelector('.chat-rows') ?? root.firstElementChild
    if (box) mutations.observe(box, { childList: true })
    measure()
    stuck()
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(scrolled)
      root.removeEventListener('scroll', onScroll)
      resize.disconnect()
      mutations.disconnect()
    }
  }, [scroll, enabled])
}
