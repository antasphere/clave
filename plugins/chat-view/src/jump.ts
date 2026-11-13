import { useEffect, useRef, useState, type RefObject } from 'react'
import { create } from 'zustand'
import { parseDelivery } from '../../../src/shared/exchange-provenance'
import { sentMessage } from './exchanges'
import type { Entry } from './reducer'
import type { Reveal } from './search'

/**
 * Opening another tab at the exchange a card shows. A message one tab
 * received is, word for word, what the other tab sent with
 * clave_send_to_session (and what it sent back arrives here the same way),
 * so the other tab finds the place by those words: the send in its tool runs,
 * or the message in its own timeline. The card asks (`requestJump`) and
 * selects the tab; the tab's view answers (`useExchangeJump`) once it is the
 * one on screen: it scrolls the row into view and flashes it, reading older
 * history page by page while the place is not loaded yet, with a pill over
 * its head saying so, and says it plainly when the place is not there.
 */

interface JumpRequest {
  text: string
  nonce: number
}

interface JumpState {
  jumps: Record<string, JumpRequest | undefined>
  request: (sessionId: string, text: string) => void
  done: (sessionId: string, nonce: number) => void
}

export const useJumpStore = create<JumpState>((set) => ({
  jumps: {},
  request: (sessionId, text) =>
    set((state) => ({ jumps: { ...state.jumps, [sessionId]: { text, nonce: Date.now() } } })),
  done: (sessionId, nonce) =>
    set((state) =>
      state.jumps[sessionId]?.nonce === nonce
        ? { jumps: { ...state.jumps, [sessionId]: undefined } }
        : state
    )
}))

export function requestJump(sessionId: string, text: string): void {
  useJumpStore.getState().request(sessionId, text)
}

/** Words compared the way a delivery may have reflowed them. */
export const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Whether an entry carries these words as an exchange: a send of this tab's,
 *  or a message another tab sent it. */
export function entryCarries(entry: Entry, words: string): boolean {
  const sent = sentMessage(entry)
  if (sent) return normalise(sent.side.text) === words
  if (entry.kind === 'user') {
    const delivery = parseDelivery(entry.text)
    return !!delivery && normalise(delivery.body) === words
  }
  return false
}

/** Whether a row of the transcript holds those words anywhere in its blocks
 *  (a run of tools, a timeline, a Terminal view exchange of several blocks). */
export function rowCarries(row: unknown, words: string): boolean {
  const seen = new Set<object>()
  const walk = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return false
    seen.add(value)
    if (Array.isArray(value)) return value.some((item) => walk(item, depth + 1))
    const v = value as Record<string, unknown>
    if (v.kind === 'tool' || v.kind === 'user') return entryCarries(v as Entry, words)
    return Object.values(v).some((item) => walk(item, depth + 1))
  }
  return walk(row, 0)
}

/** How long the search may read the past before it says the place is not here. */
const FIND_FOR_MS = 30_000
/** How long the "not here" pill stays. */
const MISSING_MS = 3500
/** How long the row's flash lasts. */
const FLASH_MS = 2400

export type JumpStatus = 'finding' | 'missing' | null

export function useExchangeJump({
  sessionId,
  rows,
  active,
  more,
  scroll
}: {
  sessionId: string
  rows: readonly { key: string }[]
  /** This view is the one on screen. */
  active: boolean
  /** Older history is left to read in (`useEarlier` reads it as the top nears). */
  more: boolean
  scroll: RefObject<HTMLDivElement | null>
}): { reveal: Reveal | null; status: JumpStatus } {
  const jump = useJumpStore((s) => s.jumps[sessionId])
  const done = useJumpStore((s) => s.done)
  const [reveal, setReveal] = useState<Reveal | null>(null)
  const [status, setStatus] = useState<JumpStatus>(null)
  const started = useRef<{ nonce: number; at: number } | null>(null)
  const missing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!active || !jump) return
    if (started.current?.nonce !== jump.nonce) {
      started.current = { nonce: jump.nonce, at: Date.now() }
      clearTimeout(missing.current)
    }
    const words = normalise(jump.text)
    const index = rows.findIndex((row) => rowCarries(row, words))
    if (index >= 0) {
      done(sessionId, jump.nonce)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- answers a request from the jump store (outside React) by scrolling the virtualiser, in the same step that marks the request done
      setStatus(null)
      setReveal({ index, nonce: Date.now(), align: 'center' })
      flash(scroll, index, words)
      return
    }
    if (more && Date.now() - started.current.at < FIND_FOR_MS) {
      // Not loaded yet: to the top, where the view reads the page before;
      // the rows that page adds run this again.
      setStatus('finding')
      setReveal({ index: 0, nonce: Date.now(), align: 'start' })
      return
    }
    done(sessionId, jump.nonce)
    setStatus('missing')
    missing.current = setTimeout(() => setStatus(null), MISSING_MS)
  }, [active, jump, rows, more, sessionId, done, scroll])

  useEffect(() => () => clearTimeout(missing.current), [])
  return { reveal, status }
}

/** Once the row is in view: open what holds the words (a closed run of tools,
 *  the timeline card) and flash the row, so the eye lands on it. */
function flash(scroll: RefObject<HTMLDivElement | null>, index: number, words: string): void {
  let tries = 0
  const look = (): void => {
    const row = scroll.current?.querySelector<HTMLElement>(`[data-row-index="${index}"]`)
    if (!row) {
      if (++tries < 30) requestAnimationFrame(look)
      return
    }
    const head = words.slice(0, 24)
    const card = [...row.querySelectorAll<HTMLDetailsElement>('details.exchange-card')].find((el) =>
      normalise(el.querySelector('.exchange-gist')?.textContent ?? '').startsWith(head)
    )
    if (card) card.open = true
    else {
      // A row that is one run of tools (the Chat view's) opens on it; an
      // exchange of several runs (the Enclave view's) only flashes.
      const runs = row.querySelectorAll<HTMLDetailsElement>('details')
      if (runs.length === 1) runs[0].open = true
    }
    row.removeAttribute('data-jump-flash')
    void row.offsetWidth
    row.setAttribute('data-jump-flash', '')
    setTimeout(() => row.removeAttribute('data-jump-flash'), FLASH_MS)
  }
  requestAnimationFrame(look)
}
