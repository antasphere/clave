import { useEffect, type RefObject } from 'react'

/** A message in the Terminal view always stands whole: it never scrolls
 *  inside its own box. A long one cannot be pinned, though: stuck under the
 *  top edge it would cover the answer under it, and the part of it below the
 *  pane could never be read while it sticks. So a message taller than
 *  PIN_SHARE of the transcript's height is left in the flow and scrolls away
 *  with its exchange; its row carries `data-tall`, which is what the
 *  stylesheet reads to unpin it. Kept as a share of the pane, so it means the
 *  same in a split pane and a full one. */
export const PIN_SHARE = 0.3

/** Whether a message this tall is too tall to pin in a pane this tall. */
export function tooTallToPin(messageHeight: number, paneHeight: number): boolean {
  return messageHeight > paneHeight * PIN_SHARE
}

export function useQuestionHeight(scroll: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = scroll.current
    if (!root) return
    const measure = (): void => {
      const pane = root.clientHeight
      for (const message of root.querySelectorAll<HTMLElement>('.term-question > .chat-turn')) {
        const row = message.closest<HTMLElement>('.chat-turn-wrap')
        if (!row) continue
        if (tooTallToPin(message.offsetHeight, pane)) row.dataset.tall = 'true'
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
    const resize = new ResizeObserver(schedule)
    resize.observe(root)
    // New exchanges, pages of the past arriving in front, and rows the
    // virtualiser mounts as they near the viewport (rows.tsx).
    const mutations = new MutationObserver(schedule)
    const box = root.querySelector('.chat-rows') ?? root.firstElementChild
    if (box) mutations.observe(box, { childList: true })
    measure()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
    }
  }, [scroll])
}
