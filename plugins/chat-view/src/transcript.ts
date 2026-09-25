import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

export interface TranscriptEnd {
  /** The scrolling element; the view puts it on its `.chat-scroll`. */
  scroll: RefObject<HTMLDivElement | null>
  /** True while the end is out of view — the cue for `JumpToEnd`. */
  away: boolean
  /** Follow the stream again without moving: a message just went. */
  stick: () => void
  /** Glide to the end and follow the stream from there. */
  jump: () => void
  /** Keep the reader's text where it is on screen across the next change of
   *  entries: called the moment before a page of the past goes in front. */
  hold: () => void
}

/** The transcript follows the stream only while the reader is at its end; a
 *  reader who scrolled up to re-read is never yanked back down, and sees the
 *  way back (`JumpToEnd`) for as long as the end is out of view. `slack` is
 *  how close to the end still counts as there. The measure runs on the
 *  element's own scroll and resize events, so the view wires nothing but the
 *  ref: a pane shown again after streaming behind another view (both of this
 *  plugin's views stay mounted, one on screen) comes back pinned rather than
 *  offering a jump the reader never asked for, since a stuck reader is
 *  re-pinned on every resize before the measure. A programmatic glide is one
 *  scroll the reader did not make: its intermediate positions are not
 *  measured, or the control would flicker back for the length of the glide;
 *  `scrollend` closes the glide whether it finished or a wheel cut it short. */
export function useTranscriptEnd(
  entries: unknown,
  slack: (el: HTMLElement) => number
): TranscriptEnd {
  const scroll = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const gliding = useRef(false)
  const held = useRef<number | null>(null)
  const [away, setAway] = useState(false)
  const measure = useCallback(() => {
    const el = scroll.current
    if (!el) return
    const next = el.scrollHeight - el.scrollTop - el.clientHeight < slack(el)
    if (next === stuck.current) return
    stuck.current = next
    setAway(!next)
  }, [slack])
  // A page put in front pushes everything down by its height: the distance
  // from the bottom is what the reader's text keeps, restored in the layout of
  // the same commit, so nothing moves on screen whatever the browser's own
  // scroll anchoring made of it (none at all at the very top).
  useLayoutEffect(() => {
    const el = scroll.current
    if (el && held.current !== null) el.scrollTop = el.scrollHeight - held.current
    held.current = null
  }, [entries])
  useEffect(() => {
    const el = scroll.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [entries])
  useEffect(() => {
    const el = scroll.current
    if (!el) return
    const onScroll = (): void => {
      if (!gliding.current) measure()
    }
    const onScrollEnd = (): void => {
      gliding.current = false
      measure()
    }
    const observer = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight
      measure()
    })
    el.addEventListener('scroll', onScroll)
    el.addEventListener('scrollend', onScrollEnd)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('scrollend', onScrollEnd)
      observer.disconnect()
    }
  }, [measure])
  const stick = useCallback(() => {
    stuck.current = true
    setAway(false)
  }, [])
  const jump = useCallback(() => {
    const el = scroll.current
    if (!el) return
    stick()
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    gliding.current = !reduced
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })
  }, [stick])
  const hold = useCallback(() => {
    const el = scroll.current
    if (el) held.current = el.scrollHeight - el.scrollTop
  }, [])
  return { scroll, away, stick, jump, hold }
}
