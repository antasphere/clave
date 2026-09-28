import { useEffect, type RefObject } from 'react'

/** The question an answer is answering stays at the top while that answer
 *  scrolls under it: the reader's own message, not a copy of it.
 *
 *  Each exchange is a section (`.term-turn`) whose first row is the message,
 *  and that row is `position: sticky`: it keeps its place in the flow, sticks
 *  to the top once the section's head has scrolled past, and leaves with the
 *  section's end, when the next question takes the top. As the section scrolls
 *  on, the row folds to its first line: never by changing its size (the flow
 *  would move under the reader, and the browser's clamp at the bottom would
 *  fold and unfold it in turn) but by clipping its painted box from the
 *  bottom, one pixel per pixel scrolled, down to one line. `--fold` carries
 *  how much is clipped; the stylesheet does the rest. Scrolling back unfolds
 *  it the same way, and a click on a folded question brings it back whole. */
export function useStickyQuestions(scroll: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const root = scroll.current
    if (!root) return
    const rows = (): HTMLElement[] =>
      Array.from(
        root.querySelectorAll<HTMLElement>('.term-turn > .chat-turn-wrap[data-side="end"]')
      )
    const reset = (row: HTMLElement): void => {
      if (!row.dataset.folded) return
      delete row.dataset.folded
      row.style.removeProperty('--fold')
    }
    if (!enabled) {
      rows().forEach(reset)
      return
    }
    /** The row folded to one line: the message's padding, border and one line,
     *  plus a padding's worth under it for the fade the fold edge draws. */
    const oneLine = (row: HTMLElement): number => {
      const message = row.querySelector<HTMLElement>('.chat-turn[data-role="user"]')
      if (!message) return row.offsetHeight
      const style = getComputedStyle(message)
      const px = (value: string): number => Number.parseFloat(value) || 0
      return (
        px(style.paddingTop) +
        px(style.paddingBottom) * 2 +
        px(style.borderTopWidth) +
        px(style.borderBottomWidth) +
        (px(style.lineHeight) || px(style.fontSize) * 1.5)
      )
    }
    let frame = 0
    const update = (): void => {
      frame = 0
      const edge = root.getBoundingClientRect().top
      for (const row of rows()) {
        const section = row.parentElement
        if (!section) continue
        // Where it sticks: the stylesheet's gap under the top edge.
        const top = edge + (Number.parseFloat(getComputedStyle(row).top) || 0)
        const box = section.getBoundingClientRect()
        const past = top - box.top
        if (past <= 0 || box.bottom <= top) {
          reset(row)
          continue
        }
        const fold = Math.max(0, Math.min(past, row.offsetHeight - oneLine(row)))
        if (fold <= 0) {
          reset(row)
          continue
        }
        row.dataset.folded = 'true'
        row.style.setProperty('--fold', `${fold}px`)
      }
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    // A folded question brings its whole self back: the section's head to the top.
    const onClick = (event: MouseEvent): void => {
      const row = (event.target as Element).closest<HTMLElement>(
        '.chat-turn-wrap[data-folded] .chat-turn'
      )?.parentElement
      const section = row?.parentElement
      if (!row || !section) return
      event.stopPropagation()
      const gap = Number.parseFloat(getComputedStyle(row).top) || 0
      root.scrollBy({
        top: section.getBoundingClientRect().top - root.getBoundingClientRect().top - gap,
        behavior: 'smooth'
      })
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(root)
    root.addEventListener('scroll', schedule, { passive: true })
    root.addEventListener('click', onClick)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      root.removeEventListener('scroll', schedule)
      root.removeEventListener('click', onClick)
      rows().forEach(reset)
    }
  }, [scroll, enabled])
}
