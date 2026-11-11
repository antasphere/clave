import { useEffect, useState } from 'react'
import { usePageTitleState } from '../digest'
import { frameAt, REVEAL_MS, revealFrames } from './reveal'
import { shownTitle, titlePending } from './title'
import type { Page } from './pages'

/* A page's title (PRDCT-4412): the first sentence of the question at once,
   then the title a helper wrote for it, rewritten in place over the stand-in
   (`reveal.ts`). While the title is being written, a quiet loader sits after
   the text; a title that does not come leaves the stand-in, and says
   nothing. */

/** The quiet loader of the folio: three dots breathing in turn, in the hand
 *  of the pen (`.folio-pen`). Still for a reader who asked for no motion. */
export function FolioLoader(): React.JSX.Element {
  return (
    <span className="folio-loader" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
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
  // Whether this head showed the stand-in while the title was written: only
  // then is the title revealed in place. A title found filed is just shown.
  const [waited, setWaited] = useState(pending)
  if (pending && !waited) setWaited(true)
  const fresh = state.state === 'done' && state.fresh === true
  // The reveal under way, and the frame of it on screen.
  const [reveal, setReveal] = useState<{ from: string; to: string } | null>(null)
  const [frame, setFrame] = useState<string | null>(null)
  const [last, setLast] = useState(final)
  if (last !== final) {
    setLast(final)
    const from = reveal ? (frame ?? reveal.from) : last
    setFrame(null)
    setReveal(waited && fresh && !reducedMotion() ? { from, to: final } : null)
  }
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
  const shown = reveal ? (frame ?? reveal.from) : final
  const revealing = shown !== final
  return (
    <h2
      className="folio-title"
      data-title={final === page.title ? 'stand-in' : 'written'}
      data-revealing={revealing ? 'true' : undefined}
      aria-label={revealing ? final : undefined}
    >
      {shown}
      {pending && <FolioLoader />}
    </h2>
  )
}
