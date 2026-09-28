import { useEffect, type RefObject } from 'react'

/** The question an answer is answering stays at the top while that answer
 *  scrolls under it: the reader's own message, not a copy of it.
 *
 *  Each exchange is a section (`.term-turn`) whose first row is the message,
 *  and that row is `position: sticky`: it keeps its place in the flow and
 *  sticks to the top once the section's head has scrolled past. As the section
 *  scrolls on, the row folds to its first line: never by changing its size (the
 *  flow would move under the reader, and the browser's clamp at the bottom
 *  would fold and unfold it in turn) but by clipping its painted box from the
 *  bottom, one pixel per pixel scrolled. `--fold` carries how much is clipped;
 *  the stylesheet does the rest. Scrolling back unfolds it the same way, and a
 *  click on a folded question brings it back whole.
 *
 *  What folds is everything under the message's first line: its other lines,
 *  and whatever the row carries under the message (its files, the
 *  "Interrupted" note). Folded, a question is exactly the box a one-line
 *  message is, the same padding above and below its line, so the caret and the
 *  words sit centred in it whatever the message was. A one-line message is
 *  already that box: only what hangs under it folds away.
 *
 *  A stuck row stands on a backdrop of the ground (`data-stuck`), from the top
 *  edge down to its fold, so nothing scrolling under it shows above it or in
 *  its rounded corners, and the backdrop travels with it.
 *
 *  The next question pushes it out with PUSH_GAP between the two, and the
 *  browser does the pushing: it is plain `position: sticky`, moved by the
 *  scroll itself, never by script. What makes the gap right is room: the sticky
 *  clamp pushes on the row's LAYOUT box, which folding leaves at full height,
 *  so each section ends with empty space as tall as its question's fold plus
 *  the gap (`--fold-space`, a spacer in the stylesheet), taken back by an equal
 *  negative margin so nothing in the flow moves. The row can travel that much
 *  further down its section, and is pushed when its folded bottom, not its
 *  unfolded one, is PUSH_GAP from the next question. Pushed on, the row and its
 *  backdrop leave together over the top edge. The row's height is bounded by
 *  question-height.ts, so a pinned question never fills the pane.
 *
 *  Script sets only the fold (the clip) and the room, never a position: the
 *  room once per change of the row's size, the fold per frame. */
const PUSH_GAP = 8
/** Where a question sticks under the top edge: the stylesheet's `top` on the
 *  row (calc(var(--spacing) * 3)). Change them together. */
const STICK_TOP = 12

export function useStickyQuestions(scroll: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const root = scroll.current
    if (!root) return
    const rows = (): HTMLElement[] =>
      Array.from(
        root.querySelectorAll<HTMLElement>('.term-turn > .chat-turn-wrap[data-side="end"]')
      )
    const reset = (row: HTMLElement): void => {
      if (!row.dataset.stuck) return
      delete row.dataset.stuck
      delete row.dataset.folded
      delete row.dataset.foldCut
      for (const name of ['--fold', '--message-fold']) row.style.removeProperty(name)
    }
    if (!enabled) {
      rows().forEach(reset)
      return
    }
    /** How much of the row stays when it is folded, from its top, and how much
     *  of the message that cuts off (0 when the message is one line, and the
     *  fold lands on its bottom edge). */
    const folded = (row: HTMLElement): { keep: number; cut: number } => {
      const message = row.querySelector<HTMLElement>('.chat-turn[data-role="user"]')
      // A row of files alone keeps them whole.
      if (!message) return { keep: row.offsetHeight, cut: 0 }
      const style = getComputedStyle(message)
      const px = (value: string): number => Number.parseFloat(value) || 0
      const line = px(style.lineHeight) || px(style.fontSize) * 1.5
      const top = message.getBoundingClientRect().top - row.getBoundingClientRect().top
      const bottom = top + message.offsetHeight
      const text = message.scrollHeight - px(style.paddingTop) - px(style.paddingBottom)
      // Half a line of slack: a single line's box is never a whole second one.
      if (text <= line * 1.5) return { keep: bottom, cut: 0 }
      const keep =
        top +
        px(style.paddingTop) +
        px(style.paddingBottom) +
        px(style.borderTopWidth) +
        px(style.borderBottomWidth) +
        line
      return { keep, cut: bottom - keep }
    }
    /* The fold geometry of each row, measured when its size changes (it
       arrives, the pane is resized, the cap is dragged), never per frame; and
       the room its section keeps at its end for it. */
    const geometry = new WeakMap<HTMLElement, { keep: number; cut: number; height: number }>()
    const measure = (row: HTMLElement): void => {
      const { keep, cut } = folded(row)
      const height = row.offsetHeight
      geometry.set(row, { keep, cut, height })
      row.parentElement?.style.setProperty('--fold-space', `${height - keep + PUSH_GAP}px`)
    }
    let frame = 0
    const update = (): void => {
      frame = 0
      const edge = root.getBoundingClientRect().top
      const all = rows()
      all.forEach((row, index) => {
        const section = row.parentElement
        if (!section || !geometry.has(row)) return
        // Where it sticks: the stylesheet's gap under the top edge.
        const top = edge + STICK_TOP
        const box = section.getBoundingClientRect()
        const past = top - box.top
        if (past <= 0 || box.bottom <= edge) {
          reset(row)
          return
        }
        // A size change reaches the resize observer after this frame's
        // update; a stuck row whose height moved is measured here instead, so
        // no frame folds it by its old height.
        if (row.offsetHeight !== geometry.get(row)?.height) measure(row)
        const { keep, cut, height } = geometry.get(row)!
        // Where the sticky rule puts the row, clamp included, from its section
        // (the row is its first child): a sticky box's own rect can lag a scroll.
        const base = Math.min(Math.max(box.top, top), box.bottom - height)
        // Folded one pixel per pixel scrolled, and never later than it must be
        // to clear the next question: a short answer under a long question
        // reaches the push before the fold is complete.
        const next = all[index + 1]?.parentElement?.getBoundingClientRect().top ?? Infinity
        const clear = base + height - (next - PUSH_GAP)
        const fold = Math.max(0, Math.min(Math.max(past, clear), height - keep))
        row.dataset.stuck = 'true'
        // Under a pixel is rounding, not something to fold.
        if (fold >= 1) row.dataset.folded = 'true'
        else delete row.dataset.folded
        if (fold >= 1 && cut > 0) row.dataset.foldCut = 'true'
        else delete row.dataset.foldCut
        row.style.setProperty('--fold', `${fold}px`)
        // The message's own share of the fold: what of it lies under the cut.
        row.style.setProperty(
          '--message-fold',
          `${Math.max(0, Math.min(cut, fold - (height - keep - cut)))}px`
        )
      })
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    // A folded question brings its whole self back: the section's head to the top.
    const onClick = (event: MouseEvent): void => {
      const target = event.target as Element
      const row = target.closest('.chat-turn-wrap[data-folded] .chat-turn')
        ? target.closest<HTMLElement>('.chat-turn-wrap[data-folded]')
        : null
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
    // Each row's size, for its geometry and its section's room.
    const sizes = new ResizeObserver((entries) => {
      for (const entry of entries) measure(entry.target as HTMLElement)
      schedule()
    })
    const watch = (): void => rows().forEach((row) => sizes.observe(row))
    // Exchanges mount and unmount as they near the viewport (rows.tsx): the
    // box of rows is where they come and go.
    const added = new MutationObserver(watch)
    const box = root.querySelector('.chat-rows') ?? root.firstElementChild
    if (box) added.observe(box, { childList: true })
    watch()
    root.addEventListener('scroll', schedule, { passive: true })
    root.addEventListener('click', onClick)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      sizes.disconnect()
      added.disconnect()
      root.removeEventListener('scroll', schedule)
      root.removeEventListener('click', onClick)
      rows().forEach((row) => {
        reset(row)
        row.parentElement?.style.removeProperty('--fold-space')
      })
    }
  }, [scroll, enabled])
}
