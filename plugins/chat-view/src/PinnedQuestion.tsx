import { useEffect, useRef, useState } from 'react'
import { ChevronDownIcon } from '@heroicons/react/24/outline'

/** The question an answer is answering, held at the top of the transcript
 *  while that answer scrolls under it.
 *
 *  It is a sticky element of no height at the head of the exchange's section
 *  (`.term-turn`), so the section is what carries it: it sticks while any of
 *  the section is on screen, and leaves with the section's end, at which point
 *  the next section's pin takes the top. It shows only once the question
 *  itself has scrolled out above the top edge, on one line; a click opens it
 *  to the whole question and closes it again. */
export function PinnedQuestion({ text }: { text: string }): React.JSX.Element {
  const pin = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const element = pin.current
    // The question's own row is the pin's next sibling.
    const question = element?.nextElementSibling
    const root = element?.closest('.chat-scroll')
    if (!element || !question || !root) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        const above =
          !entry.isIntersecting &&
          entry.boundingClientRect.top < (entry.rootBounds?.top ?? Number.NEGATIVE_INFINITY)
        setShown(above)
        if (!above) setOpen(false)
      },
      { root }
    )
    observer.observe(question)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={pin} className="term-pin" data-shown={shown || undefined}>
      <button
        type="button"
        className="term-pin-card"
        data-open={open || undefined}
        aria-hidden={!shown}
        tabIndex={shown ? 0 : -1}
        aria-expanded={open}
        title={open ? 'Show one line' : 'Show the whole question'}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="term-pin-text">{text.replace(/\s+$/, '')}</span>
        <ChevronDownIcon />
      </button>
    </div>
  )
}
