import { useLayoutEffect, type RefObject } from 'react'

/** Keep a one-line row inside its width by dropping its least needed items
 *  first. Every child that may go carries `data-fit-drop="<n>"`; the highest
 *  number goes first. On every resize of the row and every change inside it,
 *  all of them are shown again, then dropped one by one, highest first, while
 *  the row's content is wider than the row. Children without the attribute
 *  always stay. A dropped child gets `data-fit-hidden`, which the stylesheet
 *  turns into display: none.
 *
 *  Measured rather than set at fixed breakpoints because what fits depends on
 *  what the items say: a long folder name or account e-mail needs more room
 *  than a short one. Runs before paint (ResizeObserver and MutationObserver
 *  callbacks both do), so an item never flashes in before it is dropped. */
export function useFitRow(row: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = row.current
    if (!el) return
    const fit = (): void => {
      const items = [...el.querySelectorAll<HTMLElement>(':scope > [data-fit-drop]')].sort(
        (a, b) => Number(b.dataset.fitDrop) - Number(a.dataset.fitDrop)
      )
      for (const item of items) item.removeAttribute('data-fit-hidden')
      for (const item of items) {
        if (el.scrollWidth <= el.clientWidth) break
        item.setAttribute('data-fit-hidden', '')
      }
    }
    fit()
    const resize = new ResizeObserver(fit)
    resize.observe(el)
    // Content changes (a model name, a percentage, an e-mail) change what fits.
    // Attributes are not watched: fit() writes one, and would call itself.
    const mutations = new MutationObserver(fit)
    mutations.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      resize.disconnect()
      mutations.disconnect()
    }
  }, [row])
}
