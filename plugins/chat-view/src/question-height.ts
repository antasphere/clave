import { useEffect, type RefObject } from 'react'

/** A message in the Enclave view never scrolls inside its own box. A long
 *  one cannot be pinned whole, though: stuck under the top edge it would
 *  cover the answer under it. So a message taller than PIN_SHARE of the
 *  view's height carries `data-tall` on its row, and the stylesheet pins it
 *  as its first lines instead (TermQuestion opens it whole on a click).
 *  The share is of the whole view, composer and cards included, not of the
 *  transcript: a growing draft or a card arriving under the composer must
 *  not flip a message between pinned whole and pinned short. It is still a
 *  share, so it means the same in a split pane and a full one. Measured on
 *  the message's whole text, folded or not. */
export const PIN_SHARE = 0.3

/** Whether a message this tall is too tall to pin in a pane this tall. */
export function tooTallToPin(messageHeight: number, paneHeight: number): boolean {
  return messageHeight > paneHeight * PIN_SHARE
}

export function useQuestionHeight(scroll: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = scroll.current
    if (!root) return
    const view = root.closest<HTMLElement>('.chat-view') ?? root
    const measure = (): void => {
      const pane = view.clientHeight
      for (const message of root.querySelectorAll<HTMLElement>('.term-question > .chat-turn')) {
        const row = message.closest<HTMLElement>('.chat-turn-wrap')
        if (!row) continue
        const text = message.querySelector<HTMLElement>('.term-question-text')
        const whole = text
          ? message.offsetHeight - text.clientHeight + text.scrollHeight
          : message.offsetHeight
        if (tooTallToPin(whole, pane)) row.dataset.tall = 'true'
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
    resize.observe(view)
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
