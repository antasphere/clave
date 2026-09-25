import { useEffect, useRef, useState } from 'react'
import type { TranscriptEnd } from './transcript'

/** A page of the past on its way in: what puts it on screen, or null when
 *  there was nothing to add. */
export type EarlierPage = () => Promise<(() => void) | null>

/** How near the top of the transcript the next page is asked for: more than a
 *  screen ahead of the reader, so a steady scroll up never reaches a top that
 *  is still loading. */
const lead = (el: HTMLElement): number => el.clientHeight * 1.5

/** A long conversation opens on its end and reads further back only as the
 *  reader scrolls there: while `more` is true and the reader is within a
 *  screen and a half of the top, `fetch` is asked for the page before the
 *  oldest one shown, one page at a time, and the transcript holds the
 *  reader's place while it goes in (`TranscriptEnd.hold`). A transcript
 *  shorter than its pane has no scroll to wait for, so the same check runs
 *  after every page and on every resize. A hidden view has no height and
 *  asks for nothing until it is shown. */
export function useEarlier(
  transcript: Pick<TranscriptEnd, 'scroll' | 'hold'>,
  more: boolean,
  fetch: EarlierPage,
  content: unknown
): { loading: boolean } {
  const { scroll, hold } = transcript
  const [loading, setLoading] = useState(false)
  const busy = useRef(false)
  // The check reads this render's `more` and `fetch`; the listeners below are
  // bound once and call whichever is current.
  const check = useRef<() => void>(() => {})
  useEffect(() => {
    check.current = () => {
      const el = scroll.current
      if (!el || busy.current || !more) return
      if (el.clientHeight === 0 || el.scrollTop > lead(el)) return
      busy.current = true
      setLoading(true)
      void fetch()
        .catch(() => null)
        .then((apply) => {
          if (!apply) return
          hold()
          apply()
        })
        .finally(() => {
          busy.current = false
          setLoading(false)
        })
    }
  })
  // After the commit that settled the last page (`loading` back to false),
  // and a frame later: the check must see the height that page added.
  useEffect(() => {
    if (loading) return
    const frame = requestAnimationFrame(() => check.current())
    return () => cancelAnimationFrame(frame)
  }, [content, more, loading])
  useEffect(() => {
    const el = scroll.current
    if (!el) return
    const onChange = (): void => check.current()
    const observer = new ResizeObserver(onChange)
    el.addEventListener('scroll', onChange, { passive: true })
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', onChange)
      observer.disconnect()
    }
  }, [scroll])
  return { loading }
}
