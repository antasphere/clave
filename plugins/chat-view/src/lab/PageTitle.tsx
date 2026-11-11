import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePageTitleState } from '../digest'
import {
  frameAt,
  frameText,
  REVEAL_MS,
  revealFrames,
  shouldReveal,
  type RevealFrame
} from './reveal'
import { shownTitle, titlePending } from './title'
import type { Page } from './pages'

/* A page's title (PRDCT-4412): the first sentence of the question at once,
   then the title a helper wrote for it, rewritten in place over the stand-in
   (`reveal.ts`: the pen inks the new title in over the old, left to right).
   While the title is being written, a quiet loader sits after the text; a title that does not come leaves the stand-in, and says
   nothing. */

/** The quiet loader of the folio, in the hand of its drawings
 *  (`FolioDrawing`, the `.chat-drawing` rules): a short ruled line, and the
 *  pen going back over it, the accent stroke written left to right and lifted
 *  off from the left, over and over, at the pace of the pen at the foot of a
 *  page being written (`.folio-pen`). Said after a title being written and in
 *  the read control while the spoken version is prepared. For a reader who
 *  asked for no motion, the stroke stands still, half written. */
export function FolioLoader(): React.JSX.Element {
  return (
    <svg className="chat-drawing folio-loader" viewBox="0 0 20 8" aria-hidden="true">
      <line className="ln ln--thin" x1="1" y1="6.5" x2="19" y2="6.5" />
      <path
        className="ln ln--c folio-loader-stroke"
        pathLength={1}
        d="M1.5,4.5 C3.5,2 5,6 7.5,4 S11.5,2 13.5,4.25 S17,5 18.5,3"
      />
    </svg>
  )
}

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function PageTitle({
  sessionId,
  page
}: {
  sessionId: string
  page: Pick<Page, 'title' | 'titleKey'>
}): React.JSX.Element {
  const state = usePageTitleState(sessionId, page.titleKey ?? '', page.titleKey !== null)
  const final = shownTitle(page, state)
  const pending = page.titleKey !== null && titlePending(state)
  const fresh = state.state === 'done' && state.fresh === true
  // Since when this head has shown the stand-in with its loader, for this
  // page: only a title that kept it waiting (`shouldReveal`) is revealed in
  // place. A title that comes at once was filed on the host: it is just shown.
  const since = useRef<{ key: string; at: number } | null>(null)
  useEffect(() => {
    if (pending && page.titleKey !== null && since.current?.key !== page.titleKey)
      since.current = { key: page.titleKey, at: Date.now() }
  }, [pending, page.titleKey])
  // The reveal under way, and the frame of it on screen.
  const [reveal, setReveal] = useState<{ from: string; to: string } | null>(null)
  const [frame, setFrame] = useState<RevealFrame | null>(null)
  // A title that just took the head's place, until the clock says whether it
  // is revealed (the layout effect below, before the change is painted).
  const [arrival, setArrival] = useState<{ from: string; to: string } | null>(null)
  const [last, setLast] = useState(final)
  if (last !== final) {
    setLast(final)
    setArrival({ from: reveal ? (frame ? frameText(frame) : reveal.from) : last, to: final })
    setFrame(null)
    setReveal(null)
  }
  useLayoutEffect(() => {
    if (!arrival) return
    const pendingSince =
      since.current !== null && since.current.key === page.titleKey ? since.current.at : null
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the reveal is decided on the clock at the title's arrival, which a render cannot read; a layout effect settles it before the change is painted
    setReveal(shouldReveal(pendingSince, Date.now(), fresh, reducedMotion()) ? arrival : null)
    setArrival(null)
  }, [arrival, fresh, page.titleKey])
  useEffect(() => {
    if (!reveal) return
    const frames = revealFrames(reveal.from, reveal.to)
    let id = 0
    const start = performance.now()
    const step = (now: number): void => {
      const elapsed = now - start
      if (elapsed >= REVEAL_MS) {
        setFrame(null)
        setReveal(null)
        return
      }
      setFrame(frameAt(frames, elapsed))
      id = requestAnimationFrame(step)
    }
    id = requestAnimationFrame(step)
    return () => cancelAnimationFrame(id)
  }, [reveal])
  const shown = reveal ? (frame ? frameText(frame) : reveal.from) : final
  const revealing = shown !== final
  return (
    <h2
      className="folio-title"
      data-title={final === page.title ? 'stand-in' : 'written'}
      data-revealing={revealing ? 'true' : undefined}
      aria-label={revealing ? final : undefined}
    >
      {revealing && frame ? (
        <>
          {frame.settled}
          {/* the pen: the new characters still wet behind it, its line under them */}
          <span className="folio-title-pen" data-testid="folio-title-pen">
            <span className="folio-title-wet">{frame.wet}</span>
          </span>
          {frame.old && <span style={{ opacity: frame.fade }}>{frame.old}</span>}
        </>
      ) : (
        shown
      )}
      {pending && <FolioLoader />}
    </h2>
  )
}
