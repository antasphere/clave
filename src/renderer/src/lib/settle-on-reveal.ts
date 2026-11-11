/**
 * What stood still stays still when a pane comes back (PRDCT-4419).
 *
 * A chat tab nobody is looking at is hidden with `display: none`
 * (`TerminalGrid`), and an element that leaves `display: none` has no style
 * to start from: every `@starting-style` in it applies again, so the work
 * cards under the composer fold open again, and anything else that enters
 * that way enters again, each time the tab is chosen. Not an arrival, a
 * return.
 *
 * A pane that gains a box (shown again, or mounted shown) has the
 * transitions that started with it finished on the spot, before the frame
 * is painted: a ResizeObserver reports after layout and before paint, in
 * the same frame the transitions were created. A card that arrives while
 * the pane is on screen starts its transition on a frame the pane already
 * had its box, and keeps it. Keyframe animations are not touched: one that
 * loops (a drawing that breathes) restarting is not seen.
 */

/** Whether a box that measured `previous` (undefined: never measured) and
 *  now measures `next` has just appeared. */
export function revealed(previous: number | undefined, next: number): boolean {
  return next > 0 && !(previous !== undefined && previous > 0)
}

/** A CSS transition, told apart from a keyframe animation or a script's own
 *  animation by the property it carries. */
type Running = { finish: () => void } & Partial<{ transitionProperty: string }>

/** Finish every CSS transition running in `root` and under it. */
export function settle(root: { getAnimations?: (o?: { subtree: boolean }) => Running[] }): number {
  const running = root.getAnimations?.({ subtree: true }) ?? []
  let finished = 0
  for (const animation of running) {
    if (typeof animation.transitionProperty !== 'string') continue
    animation.finish()
    finished++
  }
  return finished
}

/** One observer for every pane: `observe` returns the way to stop. */
export function createRevealSettler(): { observe: (el: Element) => () => void } {
  const areas = new WeakMap<Element, number>()
  let observer: ResizeObserver | null = null
  const ensure = (): ResizeObserver => {
    observer ??= new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.borderBoxSize?.[0]
        const area = box
          ? box.inlineSize * box.blockSize
          : entry.contentRect.width * entry.contentRect.height
        const previous = areas.get(entry.target)
        areas.set(entry.target, area)
        if (revealed(previous, area))
          settle(entry.target as unknown as Parameters<typeof settle>[0])
      }
    })
    return observer
  }
  return {
    observe: (el) => {
      const o = ensure()
      o.observe(el)
      return () => {
        o.unobserve(el)
        areas.delete(el)
      }
    }
  }
}

let shared: ReturnType<typeof createRevealSettler> | null = null

/** A ref for any element hidden with `display: none` that comes back: a tab's
 *  tile, a view's slot in its tab. Stable, so React attaches it once; the
 *  function it returns is React's cleanup when the element goes. */
export function settleOnReveal(el: Element | null): (() => void) | undefined {
  if (!el) return undefined
  shared ??= createRevealSettler()
  return shared.observe(el)
}
