import { useLayoutEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from 'framer-motion'

/**
 * The pages of the Routines popover as ONE box (PRDCT-4244): the list, a
 * routine's panel, the form that creates or edits one. A change of page
 * slides the page that leaves out to one side and the next one in from the
 * other, both fading, while the box itself grows or shrinks to the size of
 * the page that arrived: one surface moving, never two boxes toggled.
 * `direction` is 1 going deeper (a row, a section's “+”, Edit) and -1 coming
 * back, so the motion reads as a path with a way back.
 *
 * The box's size is two motion values written from the first measurement
 * and animated on every later one (a ResizeObserver on the current page, so
 * a panel whose report arrives later grows the box again). Explicit from the
 * start on purpose: a box left at its natural size jumps to the next page's
 * size the frame that page mounts, before any animation can start (seen on
 * the first move, 9 November 2026). The page that leaves is popped out of
 * the flow by AnimatePresence and clipped by the box; the pages sit against
 * the box's right edge, the one the popover keeps still, so growth reads as
 * the box opening leftward with its right side in place.
 */
const EASE = [0.2, 0, 0, 1] as const
/** How far a page travels, in px: enough to read as a direction, not a swipe. */
const SHIFT = 32
const BOX = { duration: 0.28, ease: EASE }
const STILL = { duration: 0 }

const slide = {
  enter: (direction: number) => ({ x: direction * SHIFT, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: -direction * SHIFT, opacity: 0 })
}

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
  const width = useMotionValue(0)
  const height = useMotionValue(0)
  const [measured, setMeasured] = useState(false)
  useLayoutEffect(() => {
    if (!current) return
    let first = !measured
    const read = (): void => {
      const rect = current.getBoundingClientRect()
      if (first) {
        width.set(rect.width)
        height.set(rect.height)
        setMeasured(true)
        first = false
        return
      }
      const transition = reduce ? STILL : BOX
      animate(width, rect.width, transition)
      animate(height, rect.height, transition)
    }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(current)
    return () => observer.disconnect()
    // `measured` is read once, at the first page: the later pages animate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, reduce, width, height])
  return (
    <motion.div
      className="routines-pages"
      style={measured ? { width, height } : undefined}
      data-measured={measured ? 'true' : undefined}
    >
      <AnimatePresence initial={false} custom={direction} mode="popLayout">
        <motion.div
          key={page}
          ref={setCurrent}
          className="routines-page"
          data-testid="routines-page"
          custom={direction}
          variants={slide}
          initial="enter"
          animate="center"
          exit="exit"
          transition={
            reduce
              ? STILL
              : { x: { duration: 0.24, ease: EASE }, opacity: { duration: 0.18, ease: 'easeOut' } }
          }
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  )
}
