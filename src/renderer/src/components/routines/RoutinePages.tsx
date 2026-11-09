import { useLayoutEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

/**
 * The pages of the Routines popover as ONE box (PRDCT-4244): the list, a
 * routine's panel, the form that creates or edits one. A change of page
 * slides the page that leaves out to one side and the next one in from the
 * other, both fading, while the box itself grows or shrinks to the size of
 * the page that arrived: one surface moving, never two boxes toggled.
 * `direction` is 1 going deeper (a row, a section's “+”, Edit) and -1 coming
 * back, so the motion reads as a path with a way back.
 *
 * The box follows the current page's measured size (a ResizeObserver, so a
 * panel whose report arrives later grows the box again); the page that
 * leaves is popped out of the flow by AnimatePresence and clipped by the box.
 */
const EASE = [0.2, 0, 0, 1] as const
/** How far a page travels, in px: enough to read as a direction, not a swipe. */
const SHIFT = 32

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
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    if (!current) return
    const read = (): void => {
      const rect = current.getBoundingClientRect()
      setSize({ width: rect.width, height: rect.height })
    }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(current)
    return () => observer.disconnect()
  }, [current])
  return (
    <motion.div
      className="routines-pages"
      initial={false}
      animate={size ?? undefined}
      transition={reduce ? { duration: 0 } : { duration: 0.28, ease: EASE }}
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
              ? { duration: 0 }
              : { x: { duration: 0.24, ease: EASE }, opacity: { duration: 0.18, ease: 'easeOut' } }
          }
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  )
}
