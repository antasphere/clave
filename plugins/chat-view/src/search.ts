import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  byPane,
  findRanges,
  paint,
  usePaneSearchStore
} from '../../../src/renderer/src/views/pane-search'
import { parseDelivery } from '../../../src/shared/exchange-provenance'

/**
 * Find in this conversation, for the field in the pane's header (PaneSearch,
 * through `usePaneSearchStore`).
 *
 * The transcript's rows are virtualised (rows.tsx): only the stretch around the
 * reader is in the page, so a search of the page counted differently at every
 * scroll position. This one searches the conversation's own entries, every
 * row the view holds, and shows a match by scrolling its row into view, where
 * the words are marked with the CSS Custom Highlight API.
 *
 * - What is searched: the messages as they read, the reader's and the
 *   agent's, and error notices. Tool calls are not: their output sits behind
 *   a closed group, and a match there would point at nothing on screen.
 * - The query settles for DEBOUNCE_MS before it is searched; the field shows a
 *   spinner meanwhile.
 * - The first match shown is the newest. Older walks up; at the oldest match
 *   of what the view holds, when more history exists, the search scrolls to
 *   the top so the view reads the next page in (useEarlier), and carries on
 *   there, so the whole session is reachable. Past the start, it wraps to the
 *   newest.
 */

export const DEBOUNCE_MS = 200
/** Where message text lives in both views' rows. */
export const MESSAGE_TEXT = 'article.chat-turn, .chat-notice[data-tone="error"]'
/** How long to wait for a page of the past before giving up on it. */
const PAGE_WAIT_MS = 5000

/** The texts a row shows as messages, in order: every user, assistant and
 *  error entry anywhere in the row's structure, each read once. */
export function rowTexts(row: unknown): string[] {
  const out: string[] = []
  const seen = new Set<object>()
  const walk = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    const v = value as Record<string, unknown>
    if (v.kind === 'user' && typeof v.text === 'string') {
      if (!v.withdrawn) out.push(parseDelivery(v.text)?.body ?? v.text)
      return
    }
    if (v.kind === 'assistant' && typeof v.text === 'string') {
      out.push(v.text)
      return
    }
    if (v.kind === 'error' && typeof v.message === 'string') {
      out.push(v.message)
      return
    }
    // A call's input and output, a permission's request: never a message.
    if (v.kind === 'tool' || v.kind === 'permission') return
    for (const key of Object.keys(v)) walk(v[key], depth + 1)
  }
  walk(row, 0)
  return out
}

function occurrences(text: string, needle: string): number {
  let n = 0
  let at = text.indexOf(needle)
  while (at !== -1) {
    n++
    at = text.indexOf(needle, at + needle.length)
  }
  return n
}

/** For every occurrence of `needle` in a row, counted the way `rowTexts`
 *  counts and in the same order, which card of the agent's working notes
 *  (WorkStretch, a `work-stretch` block) holds it: its index among the row's
 *  cards, or null for words outside every card (the reader's message, the
 *  answer, an error). The Terminal view's row is a whole turn, so a card's
 *  words sit between the message's and the answer's, and a closed card that
 *  was never opened has none of them on screen: the mark has to know. */
export function occurrenceCards(row: unknown, needle: string): (number | null)[] {
  const out: (number | null)[] = []
  let card = -1
  const visit = new Set<object>()
  const walk = (value: unknown, inCard: number, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > 8 || visit.has(value)) return
    visit.add(value)
    if (Array.isArray(value)) {
      for (const item of value) walk(item, inCard, depth + 1)
      return
    }
    const v = value as Record<string, unknown>
    if (v.kind === 'work-stretch') {
      card++
      const mine = card
      for (const key of Object.keys(v)) walk(v[key], mine, depth + 1)
      return
    }
    const text =
      v.kind === 'user' && typeof v.text === 'string' && !v.withdrawn
        ? (parseDelivery(v.text)?.body ?? v.text)
        : v.kind === 'assistant' && typeof v.text === 'string'
          ? v.text
          : v.kind === 'error' && typeof v.message === 'string'
            ? v.message
            : null
    if (text !== null) {
      const n = occurrences(text.toLocaleLowerCase(), needle)
      for (let i = 0; i < n; i++) out.push(inCard < 0 ? null : inCard)
      return
    }
    if (v.kind === 'tool' || v.kind === 'permission') return
    for (const key of Object.keys(v)) walk(v[key], inCard, depth + 1)
  }
  walk(row, -1, 0)
  return out
}

/** Which card holds the `k`-th occurrence of `needle` in a row, or null. */
export function cardHolding(row: unknown, needle: string, k: number): number | null {
  return occurrenceCards(row, needle)[k] ?? null
}

/** The `k`-th occurrence's place among the words ON SCREEN in the row: the
 *  occurrences before it that live in a closed card never opened (no body in
 *  the document) are not there to count. `onScreen(card)` says whether a
 *  card's words are in the document: open, or built once and closed since. */
export function onScreenIndex(
  where: readonly (number | null)[],
  k: number,
  onScreen: (card: number) => boolean
): number {
  let hidden = 0
  for (let i = 0; i < k && i < where.length; i++) {
    const card = where[i]
    if (card !== null && !onScreen(card)) hidden++
  }
  return k - hidden
}

/** One match: its row, and which occurrence it is within that row. */
export interface Match {
  row: number
  key: string
  k: number
}

/** Every case-insensitive occurrence of `query` across the rows, in order. */
export function findMatches(rows: readonly { key: string }[], query: string): Match[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  const out: Match[] = []
  rows.forEach((row, index) => {
    let k = 0
    for (const text of rowTexts(row)) {
      const n = occurrences(text.toLocaleLowerCase(), needle)
      for (let i = 0; i < n; i++) out.push({ row: index, key: row.key, k: k++ })
    }
  })
  return out
}

/** What the view does with a search: the row to bring into view. */
export interface Reveal {
  index: number
  nonce: number
  align: 'center' | 'start'
}

export function useTranscriptSearch({
  sessionId,
  rows,
  active,
  scroll,
  more
}: {
  sessionId: string
  rows: readonly { key: string }[]
  /** This view is the one on screen; a hidden view answers nothing. */
  active: boolean
  scroll: RefObject<HTMLDivElement | null>
  /** Older history is left to read in. */
  more: boolean
}): Reveal | null {
  const find = usePaneSearchStore((s) => (active ? s.finds[sessionId] : undefined))
  const report = usePaneSearchStore((s) => s.report)
  const query = find?.query.trim() ?? ''
  const [settled, setSettled] = useState('')
  useEffect(() => {
    if (!query) {
      setSettled('')
      return
    }
    const timer = setTimeout(() => setSettled(query), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])
  const matches = useMemo(() => findMatches(rows, settled), [rows, settled])

  const [current, setCurrent] = useState<{ key: string; k: number } | null>(null)
  const [reveal, setReveal] = useState<Reveal | null>(null)
  const [paging, setPaging] = useState(false)
  const [atStart, setAtStart] = useState(false)
  /** The match the older walk stood on when it went to read the past. */
  const anchor = useRef<{ key: string; k: number } | null | undefined>(undefined)
  const pageTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Bring the current match's words into view after the next paint. */
  const scrollToWords = useRef(false)

  const index = current ? matches.findIndex((m) => m.key === current.key && m.k === current.k) : -1

  const select = (i: number): void => {
    const m = matches[i]
    if (!m) return
    setCurrent({ key: m.key, k: m.k })
    scrollToWords.current = true
    setReveal((r) => ({
      index: m.row,
      nonce: Math.max(Date.now(), (r?.nonce ?? 0) + 1),
      align: 'center'
    }))
  }
  const readPast = (from: { key: string; k: number } | null): void => {
    anchor.current = from
    setPaging(true)
    setReveal((r) => ({
      index: 0,
      nonce: Math.max(Date.now(), (r?.nonce ?? 0) + 1),
      align: 'start'
    }))
    clearTimeout(pageTimer.current)
    pageTimer.current = setTimeout(() => {
      anchor.current = undefined
      setPaging(false)
      setAtStart(true)
    }, PAGE_WAIT_MS)
  }

  // A new query: start on the newest match.
  useEffect(() => {
    clearTimeout(pageTimer.current)
    anchor.current = undefined
    setPaging(false)
    setAtStart(false)
    if (!settled || matches.length === 0) {
      setCurrent(null)
      return
    }
    select(matches.length - 1)
    // Only a new query restarts the walk; rows arriving keep the match.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled])

  // A step from the field.
  const stepNonce = find?.step.nonce ?? 0
  const stepSeen = useRef(stepNonce)
  useEffect(() => {
    if (stepNonce === stepSeen.current) return
    stepSeen.current = stepNonce
    if (!settled || paging) return
    if (find?.step.dir === 'newer') {
      if (matches.length) select(index >= 0 && index < matches.length - 1 ? index + 1 : 0)
      return
    }
    if (index > 0) return select(index - 1)
    if (more) return readPast(index === 0 ? matches[0] : null)
    setAtStart(true)
    if (matches.length) select(matches.length - 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepNonce])

  // A page of the past arrived while the older walk waits on it.
  useEffect(() => {
    if (anchor.current === undefined) return
    const from = anchor.current
    const at = from
      ? matches.findIndex((m) => m.key === from.key && m.k === from.k)
      : matches.length
    if (at > 0) {
      clearTimeout(pageTimer.current)
      anchor.current = undefined
      setPaging(false)
      select(at - 1)
      return
    }
    if (!more) {
      clearTimeout(pageTimer.current)
      anchor.current = undefined
      setPaging(false)
      setAtStart(true)
      if (matches.length) select(matches.length - 1)
      return
    }
    // Nothing new above yet: keep reading the past.
    setReveal((r) => ({
      index: 0,
      nonce: Math.max(Date.now(), (r?.nonce ?? 0) + 1),
      align: 'start'
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, more])

  // Tell the field.
  useEffect(() => {
    if (!active || !find) return
    report(sessionId, {
      total: matches.length,
      position: index >= 0 ? matches.length - index : 0,
      pending: query !== '' && query !== settled,
      paging,
      atStart
    })
  }, [active, find?.query, matches.length, index, settled, paging, atStart, sessionId, report]) // eslint-disable-line react-hooks/exhaustive-deps

  // Mark the words on the rows in the page: every match, and the current one.
  const currentMatch = index >= 0 ? matches[index] : null
  useEffect(() => {
    const scroller = scroll.current
    if (!active || !settled || !scroller) {
      if (byPane.delete(sessionId)) paint()
      return
    }
    const mark = (): void => {
      const all = findRanges(scroller, settled, MESSAGE_TEXT)
      let currentRange: Range | null = null
      if (currentMatch) {
        const rowEl = scroller.querySelector<HTMLElement>(`[data-row-index="${currentMatch.row}"]`)
        if (rowEl) {
          // The words may be inside a closed card of the agent's working
          // notes (WorkStretch): read off the row's data which card holds
          // them, open that one, and let the marking run again once its body
          // is on screen. Decided on the data, not on the ranges found: a
          // card opened once keeps its body in the document, closed, and a
          // range found there would mark words the reader cannot see. Then
          // the place among the words on screen: a card never opened has
          // none of its words there, so its occurrences before this one are
          // not counted (the Terminal view's row is a whole turn).
          const needle = settled.toLocaleLowerCase()
          const where = occurrenceCards(rows[currentMatch.row], needle)
          const cards = rowEl.querySelectorAll<HTMLDetailsElement>('details.stretch-card')
          const holder = where[currentMatch.k] ?? null
          const card = holder === null ? null : cards[holder]
          if (card && !card.open) {
            // The observer watches children and text, not attributes, and a
            // card opened once keeps its body: mark again a beat later.
            card.open = true
            setTimeout(mark, 60)
            return
          }
          const inRow = findRanges(rowEl, settled, MESSAGE_TEXT)
          const at = onScreenIndex(
            where,
            currentMatch.k,
            (index) => !!cards[index] && (cards[index].open || !!cards[index].querySelector('.stretch-steps'))
          )
          currentRange = inRow[Math.min(at, inRow.length - 1)] ?? null

        }
      }
      byPane.set(sessionId, { all, current: currentRange })
      paint()
      if (currentRange && scrollToWords.current) {
        scrollToWords.current = false
        const box = currentRange.getBoundingClientRect()
        const frame = scroller.getBoundingClientRect()
        if (box.top < frame.top + 24 || box.bottom > frame.bottom - 24)
          scroller.scrollTop += box.top - frame.top - frame.height / 2
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = (): void => {
      clearTimeout(timer)
      timer = setTimeout(mark, 60)
    }
    soon()
    const observer = new MutationObserver(soon)
    observer.observe(scroller, { childList: true, subtree: true, characterData: true })
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [active, settled, currentMatch?.row, currentMatch?.k, reveal?.nonce, scroll, sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // The field closed: nothing marked, nothing pending.
  useEffect(() => {
    if (find) return
    clearTimeout(pageTimer.current)
    anchor.current = undefined
    setCurrent(null)
    setReveal(null)
    if (byPane.delete(sessionId)) paint()
  }, [find, sessionId])

  return reveal
}
