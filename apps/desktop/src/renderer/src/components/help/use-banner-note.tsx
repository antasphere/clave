import { useState, type ReactNode } from 'react'
import { ChevronRightIcon } from '@heroicons/react/24/outline'
import { motion, AnimatePresence } from 'framer-motion'

/**
 * The expandable note under the sidebar's what's-new card.
 *
 * That card printed the whole release note — several paragraphs — at a user who
 * had not asked for it. The answer: the card is a headline at rest, and the
 * changelog is one click under it. (The update card had the mirror problem and
 * a different answer — its notes are reference beside a decision, so they live
 * in a panel off the icon rather than in a fold: see `ReleaseNotesBadge`.)
 *
 * Collapsed is the default. The rest state of an announcement is a single
 * line — a card that opens itself is the unbounded card again, just with a
 * chevron on it.
 *
 * The height cap survives expansion and is the reason this is a component
 * rather than a `<details>`. These cards live in the sidebar's `flex-shrink-0`
 * announcements block: an unbounded one pushes the session list and the foot
 * panel off the bottom of the window with nothing to scroll (the bug
 * `tests/e2e/sidebar-whats-new.spec.mjs` was written for). Expanded means the
 * note is readable in place, scrolled inside its own box — never that the card
 * is free to grow.
 *
 * **The trigger and the note are returned as separate elements, and a caller
 * must not wrap them in one flex row.** The trigger usually shares a row with
 * a sibling control ("Try it"); the note underneath needs the card's full
 * width. Putting both in that row makes the row a flex parent of the note too,
 * which lays the paragraphs out in a narrow column beside the chevron — a
 * layout bug no assertion about height or scrolling can see, because the box is
 * still capped and still scrolls. Render `trigger` inside the row and `note`
 * after it, as a sibling of the row.
 */
export function useBannerNote(
  children: ReactNode,
  label: string,
  defaultOpen = false
): { trigger: ReactNode; note: ReactNode; open: boolean } {
  const [open, setOpen] = useState(defaultOpen)

  const trigger = (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      className="flex items-center gap-1 text-[11px] text-accent hover:text-accent-hover font-medium mt-1"
    >
      <ChevronRightIcon
        className={`w-3 h-3 flex-shrink-0 transition-transform duration-150 ${
          open ? 'rotate-90' : ''
        }`}
      />
      {open ? 'Hide details' : "What's changed"}
      <span className="sr-only"> — {label}</span>
    </button>
  )

  const note = (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.15, ease: [0.2, 0, 0, 1] }}
          className="overflow-hidden"
        >
          {/* The cap and the scroll: an open note reads INSIDE the card rather
              than growing it. `overscroll-contain` keeps a note scrolled to its
              end from handing the wheel on to the session list underneath. */}
          <div className="mt-1 max-h-40 overflow-y-auto overscroll-contain text-[11px] text-text-secondary leading-relaxed">
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )

  return { trigger, note, open }
}
