import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from 'framer-motion'

/**
 * The pages of the Routines popover as ONE box (PRDCT-4244): the list, a
 * routine's panel, the form that creates or edits one. A change of page
 * slides the page that leaves out to one side and fades it, the next one
 * comes in from the other side a beat later, and the box itself grows or
 * shrinks to the size of the page that arrived: one surface moving, never
 * two boxes toggled. `direction` is 1 going deeper (a row, a section's “+”,
 * Edit) and -1 coming back, so the motion reads as a path with a way back.
 *
 * Three layers, each for a reason measured on 9 November 2026:
 *
 * - The FRAME is what the popover's positioning engine sizes: it takes the
 *   current page's measured size at once, so the engine places the popover
 *   once per page instead of chasing an animated size a frame late (that
 *   chase was a right edge that wobbled).
 * - The SURFACE (the menu paper) hangs from the frame's top-right corner,
 *   the corner the popover keeps still under its button, and animates its
 *   size to the frame's through two motion values, explicit from the first
 *   measurement (a surface left at its natural size jumped to the next
 *   page's size the frame that page mounted). Growth opens leftward and
 *   downward with the right side in place.
 * - The PAGES hang from that same corner, absolutely, so the page that
 *   leaves stays where it was while the box grows past it; pinned to the
 *   left edge it travelled with that edge, two hundred pixels in a quarter
 *   second, on top of its own slide.
 *
 * The slide is the `transform` string, which the browser accelerates in
 * every version of the library (`x` runs on the main thread in this one,
 * right while the panel mounts its report). The box's duration scales with
 * how far it moves, clamped; the pages share the easing family at lighter
 * curves, the arriving page starting a beat after the leaving one so two
 * rich views never fight at full strength. Reduced motion keeps the fades,
 * drops the travel and the box's animation.
 */
/** The app's `--ease-out-expo`: the box. */
const EASE_BOX = [0.2, 0, 0, 1] as const
/** A lighter ease-out of the same family: the pages. */
const EASE_PAGE = [0.26, 0.08, 0.25, 1] as const
/** How far a page travels, in px: enough to read as a direction, not a swipe. */
const SHIFT = 24
const EXIT = 0.16
const ENTER = 0.2
/** The arriving page starts once the leaving one is well on its way. */
const ENTER_DELAY = 0.06
/** The box: a small change settles fast, a large one takes the full beat. */
const BOX_MIN = 0.2
const BOX_MAX = 0.28
/** Pixels of change per second of box animation, before clamping. */
const BOX_RATE = 700

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

export function RoutinePages({
  page,
  direction,
  children
}: {
  /** One key per page; a change of key is a change of page. */
  page: string
  direction: 1 | -1
  children: ReactNode
}): React.JSX.Element {
  const reduce = useReducedMotion()
  const [current, setCurrent] = useState<HTMLDivElement | null>(null)
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null)
  const width = useMotionValue(0)
  const height = useMotionValue(0)
  const last = useRef<{ width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    if (!current) return
    const read = (): void => {
      const rect = current.getBoundingClientRect()
      const next = { width: rect.width, height: rect.height }
      const prev = last.current
      last.current = next
      setFrame(next)
      if (!prev) {
        width.set(next.width)
        height.set(next.height)
        return
      }
      const delta = Math.max(Math.abs(next.width - prev.width), Math.abs(next.height - prev.height))
      if (delta < 0.5) return
      const duration = reduce ? 0 : clamp(delta / BOX_RATE, BOX_MIN, BOX_MAX)
      animate(width, next.width, { duration, ease: EASE_BOX })
      animate(height, next.height, { duration, ease: EASE_BOX })
    }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(current)
    return () => observer.disconnect()
  }, [current, reduce, width, height])
  const variants = useMemo(() => {
    const shift = reduce ? 0 : SHIFT
    return {
      enter: (d: number) => ({ transform: `translateX(${d * shift}px)`, opacity: 0 }),
      center: {
        transform: 'translateX(0px)',
        opacity: 1,
        transition: reduce
          ? { duration: 0.12 }
          : { duration: ENTER, delay: ENTER_DELAY, ease: EASE_PAGE }
      },
      exit: (d: number) => ({
        transform: `translateX(${-d * shift}px)`,
        opacity: 0,
        transition: reduce ? { duration: 0.08 } : { duration: EXIT, ease: EASE_PAGE }
      })
    }
  }, [reduce])
  return (
    <div
      className="routines-frame"
      data-testid="routines-frame"
      style={frame ? { width: frame.width, height: frame.height } : undefined}
    >
      <motion.div
        className="routines-surface menu-surface"
        style={frame ? { width, height } : undefined}
      >
        <AnimatePresence initial={false} custom={direction}>
          <motion.div
            key={page}
            ref={setCurrent}
            className="routines-page"
            data-testid="routines-page"
            custom={direction}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
