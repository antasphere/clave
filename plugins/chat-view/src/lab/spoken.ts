import { useEffect } from 'react'
import { create } from 'zustand'
import type { DigestLaunch } from '../../../../src/shared/exchange-digest'
import { clipText } from '../../../../src/shared/helper-prompt'
import {
  SPOKEN_MAX_CHARS,
  spokenKey,
  type SpokenDone,
  type SpokenResult
} from '../../../../src/shared/spoken-rendering'
import { canAskAgain, digestFailureWords, type DigestFailure } from '../digest'
import { speakable } from './speech'

/* The spoken rendering of a page (PRDCT-4409): the answer rewritten by a
   helper to be heard rather than read — no markdown, no code read out, the
   lists said as sentences. Asked on demand, when a page is read aloud, and
   filed by the host under the tab, so a page read before is spoken at once.
   The rendering is never shown: it is only ever spoken. When it cannot be
   had, the page is read as written (`speakable`), and the control says why. */

/** Where a page's spoken rendering stands, for its read control. */
export type SpokenState =
  | { state: 'idle' }
  | { state: 'preparing' }
  | { state: 'ready'; text: string }
  | { state: 'failed'; reason?: DigestFailure }

/** What a request for a rendering comes back with: the host's answer, or a
 *  failure of the call itself (a rejection reads as the server not
 *  answering, as the digests read it). */
export type SpokenAnswer = SpokenDone | { ok: false; error: string; reason?: DigestFailure }

interface SpokenStore {
  states: Record<string, SpokenState | undefined>
  set: (id: string, state: SpokenState) => void
}

export const useSpokenStore = create<SpokenStore>((set) => ({
  states: {},
  set: (id, state) => set((s) => ({ states: { ...s.states, [id]: state } }))
}))

const idOf = (sessionId: string, key: string): string => `${sessionId}|${key}`

/** The key of a page's spoken rendering: the markdown clipped as the host
 *  clips it before keying, so both sides name the same text. */
export function spokenKeyOf(markdown: string): string {
  return spokenKey(clipText(markdown, SPOKEN_MAX_CHARS))
}

/** The renderings filed for each tab, loaded once per tab. */
const loads = new Map<string, Promise<void>>()
/** The requests in flight, one per page. */
const inFlight = new Map<string, Promise<SpokenAnswer>>()

/** Load what is filed for a tab, once: every rendering found is ready. */
export function loadSpokenRenderings(sessionId: string): Promise<void> {
  const known = loads.get(sessionId)
  if (known) return known
  const filed =
    (typeof window !== 'undefined'
      ? window.electronAPI?.spokenRenderingsOf?.(sessionId)
      : undefined) ?? Promise.resolve({} as Record<string, SpokenDone>)
  const load = filed
    .catch(() => ({}) as Record<string, SpokenDone>)
    .then((found) => {
      useSpokenStore.setState((s) => {
        const states = { ...s.states }
        for (const [key, done] of Object.entries(found ?? {}))
          if (done?.ok && typeof done.text === 'string')
            states[idOf(sessionId, key)] = { state: 'ready', text: done.text }
        return { states }
      })
    })
  loads.set(sessionId, load)
  return load
}

/**
 * A page's spoken rendering, asked now. A rendering filed or read before is
 * answered at once; a request already going is shared, not sent twice; a
 * failure that asking again cannot mend (switched off, refused) is answered
 * at once too, so the page is read as written without a wait.
 */
export function requestSpokenRendering(
  sessionId: string,
  key: string,
  launch: DigestLaunch,
  markdown: string
): Promise<SpokenAnswer> {
  const id = idOf(sessionId, key)
  const going = inFlight.get(id)
  if (going) return going
  const request = loadSpokenRenderings(sessionId)
    .then(async (): Promise<SpokenAnswer> => {
      const known = useSpokenStore.getState().states[id]
      if (known?.state === 'ready') return { ok: true, text: known.text }
      if (known?.state === 'failed' && !canAskAgain(known.reason))
        return { ok: false, error: 'not asked again', reason: known.reason }
      useSpokenStore.getState().set(id, { state: 'preparing' })
      // Sent clipped as it is keyed: the wire refuses a longer text.
      const call = window.electronAPI?.spokenRendering?.({
        sessionId,
        key,
        launch,
        markdown: clipText(markdown, SPOKEN_MAX_CHARS)
      })
      const answer: SpokenAnswer = call
        ? await (call as Promise<SpokenResult>).catch(
            (error: unknown): SpokenAnswer => ({
              ok: false,
              error: String(error),
              reason: 'unanswered'
            })
          )
        : { ok: false, error: 'This app cannot prepare a spoken version.' }
      useSpokenStore
        .getState()
        .set(
          id,
          answer.ok
            ? { state: 'ready', text: answer.text }
            : { state: 'failed', reason: answer.reason }
        )
      return answer
    })
    .finally(() => inFlight.delete(id))
  inFlight.set(id, request)
  return request
}

/** Where a page's spoken rendering stands, for its read control. */
export function useSpokenState(sessionId: string, key: string): SpokenState {
  return useSpokenStore((s) => s.states[idOf(sessionId, key)]) ?? { state: 'idle' }
}

/** Load the tab's filed renderings when its view opens, so a page read
 *  before is spoken without a wait. */
export function useSpokenRenderings(sessionId: string): void {
  useEffect(() => {
    void loadSpokenRenderings(sessionId)
  }, [sessionId])
}

/** What a reading speaks, decided on the rendering's answer: the rendering
 *  when there is one, else the page as written, with why. Pure. */
export function spokenSource(
  answer: SpokenAnswer | null,
  markdown: string
): { text: string; fallback?: DigestFailure | 'missing' } {
  if (answer?.ok && answer.text.trim()) return { text: speakable(answer.text) }
  return {
    text: speakable(markdown),
    fallback: answer && !answer.ok ? (answer.reason ?? 'failed') : 'missing'
  }
}

/** What the read control says on hover once a page was read as written. */
export function fallbackLine(reason: DigestFailure | 'missing'): string {
  const words =
    reason === 'disabled'
      ? 'spoken versions are switched off in Settings.'
      : reason === 'missing'
        ? 'no spoken version came back.'
        : digestFailureWords(reason)
  return `Read as written: ${words.charAt(0).toLowerCase()}${words.slice(1)}`
}

/** Forget every rendering and request: a test's clean slate. */
export function resetSpoken(): void {
  loads.clear()
  inFlight.clear()
  useSpokenStore.setState({ states: {} })
}
