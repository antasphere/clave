import { useCallback, useEffect, useRef, useState } from 'react'
import { InformationCircleIcon } from '@heroicons/react/24/solid'
import { Popover, PopoverAnchor, PopoverContent } from '@clave/ui/components'
import { ReleaseNotes } from './ReleaseNotes'
import type { ReleaseNote } from '../../store/updater-store'

const OPEN_DELAY = 120
const CLOSE_DELAY = 200

/**
 * "What's in this update", as a mark on the update icon rather than as a fold
 * in the card.
 *
 * The disclosure this replaces lived inside the update banner, which put the
 * changelog in the same box as the two decisions the card exists for — Later
 * and Update. Reading it grew the card, pushed the buttons down, and made an
 * announcement nobody asked for into the tallest thing in the sidebar. The
 * changelog is *reference*, not part of the choice: it belongs beside the card,
 * on demand, and gone again the moment the pointer leaves.
 *
 * Hover opens it and click pins it. Both, because the two uses differ: a glance
 * at what changed wants no click at all, while following a link in a note (or
 * scrolling three releases of them) needs the panel to stay put while the
 * pointer travels to it. A pinned panel is dismissed by the badge again, by
 * Escape, or by clicking away.
 *
 * The delays are the anti-flicker pair: 120ms before opening, so crossing the
 * icon on the way somewhere else opens nothing, and 200ms before closing, so
 * the gap between the badge and the panel can be crossed.
 *
 * The badge is an `Anchor`, not a `Trigger`, on purpose. Radix's trigger owns
 * the click and toggles from its own idea of `open` — which, once hover has
 * already opened the panel, is the opposite of what the click means: clicking
 * to PIN a hover-opened panel would close it. Anchoring keeps positioning and
 * gives the click one owner, and `onInteractOutside` is taught to ignore the
 * badge so a click there is not also an outside-dismiss.
 */
export function ReleaseNotesBadge({
  notes,
  version
}: {
  notes: ReleaseNote[]
  version: string | null
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  /** Click-pinned: hovering away no longer closes it. */
  const [pinned, setPinned] = useState(false)
  const badgeRef = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  // A pending open that fires after the card has gone — the update was taken,
  // or dismissed — would set state on nothing. Cancel on the way out.
  useEffect(() => clear, [clear])

  const schedule = useCallback(
    (next: boolean, delay: number): void => {
      clear()
      timer.current = setTimeout(() => {
        timer.current = null
        setOpen(next)
      }, delay)
    },
    [clear]
  )

  const hoverIn = useCallback((): void => schedule(true, OPEN_DELAY), [schedule])

  const hoverOut = useCallback((): void => {
    if (pinned) {
      clear()
      return
    }
    schedule(false, CLOSE_DELAY)
  }, [clear, pinned, schedule])

  const toggle = useCallback((): void => {
    clear()
    const next = !pinned
    setPinned(next)
    setOpen(next)
  }, [clear, pinned])

  const label = `What's changed in ${version ? `version ${version}` : 'the update'}`

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Escape and outside clicks arrive here; they end the pin too, or the
        // badge would still believe the panel was being held open.
        clear()
        setOpen(next)
        if (!next) setPinned(false)
      }}
    >
      <PopoverAnchor asChild>
        <button
          ref={badgeRef}
          type="button"
          data-testid="release-notes-badge"
          aria-label={label}
          aria-expanded={open}
          title={label}
          onClick={toggle}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
          onFocus={hoverIn}
          onBlur={hoverOut}
          className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-surface-0 text-accent hover:text-accent-hover transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {/* Solid, so the "i" is a knockout showing the disc behind it: an
              outline glyph at 14px on a coloured tile is a smudge. */}
          <InformationCircleIcon className="w-3.5 h-3.5" />
        </button>
      </PopoverAnchor>

      {/* To the right of the sidebar, where there is room: the card sits at the
          foot of a 260px column, so a panel above or below it is either off the
          bottom of the window or on top of the session list. */}
      <PopoverContent
        side="right"
        align="end"
        sideOffset={10}
        collisionPadding={12}
        data-testid="release-notes-popover"
        // Hover opened this; taking focus off whatever the user was doing
        // because a pointer crossed an icon would be the icon stealing the app.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          if (badgeRef.current?.contains(e.target as Node)) e.preventDefault()
        }}
        onMouseEnter={clear}
        onMouseLeave={hoverOut}
        className="w-[280px] p-3"
      >
        <p className="text-[11px] font-medium text-text-primary mb-1.5">
          What&apos;s new{version ? ` in v${version}` : ''}
        </p>
        {/* Capped and scrolling for the same reason the fold was: three
            releases of notes is a screenful, and a panel taller than the window
            has no way back to its own top. */}
        <div className="max-h-64 overflow-y-auto overscroll-contain text-[11px] leading-relaxed text-text-secondary">
          <ReleaseNotes notes={notes} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
