/**
 * The line a message from another tab leaves when it goes unsent
 * (PRDCT-4566): the person withdrew it or stopped the turn, and nothing
 * failed. The adapter says it as a notice marked `quiet`, and every skin
 * draws it in the look its neutral facts already have, never in the red of
 * a failure: Chat and Enclave as the mode line is drawn (`.chat-notice`,
 * small and grey in the column's centre, a status), Folio as its page's
 * aside, the way a stopped page says it stopped. A notice that reports a
 * failure keeps its red, in every skin. The quiet line answers nothing: it
 * never brings back the message Escape just took back.
 */
import { describe, expect, it, vi } from 'vitest'
import * as ReactModule from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionEvent } from '../../../shared/session-model'
import {
  answeredSince,
  emptyConversation,
  reduceConversation,
  type Conversation,
  type Entry
} from '../../../../plugins/chat-view/src/reducer'
import { visibleEntries } from '../../../../plugins/chat-view/src/tools'
import { EntryRow as ChatRow } from '../../../../plugins/chat-view/src/ChatView'
import { EntryRow as EnclaveRow } from '../../../../plugins/chat-view/src/TerminalEntry'
import { Line as FolioLine } from '../../../../plugins/chat-view/src/lab/FolioView'

// The dock's modules keep the reader's disclosures in localStorage at load.
vi.hoisted(() => {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
})
// The plugin's files sit outside the renderer's tsconfig, so vitest may
// compile their JSX to the classic runtime, which reads React off the scope.
;(globalThis as { React?: unknown }).React = ReactModule

const NOT_SENT = 'A message from Lane B was not sent.'
const FAILED = 'OpenCode turn failed: the model is overloaded.'
const run = (events: SessionEvent[], from: Conversation = emptyConversation): Conversation =>
  events.reduce((state, event) => reduceConversation(state, { event, at: 1 }), from)
/** The entry each notice becomes, as every skin is handed it. */
const entryOf = (event: SessionEvent): Entry => {
  const entry = run([event]).entries.at(-1)
  if (!entry) throw new Error('no entry')
  return entry
}
const quiet = entryOf({ type: 'error', message: NOT_SENT, fatal: false, quiet: true })
const failure = entryOf({ type: 'error', message: FAILED, fatal: false })
const onError = (): void => {}

/** A notice as each skin draws it in the transcript. */
const skins: Record<string, (entry: Entry) => string> = {
  Chat: (entry) => renderToStaticMarkup(createElement(ChatRow, { entry, onError })),
  Enclave: (entry) => renderToStaticMarkup(createElement(EnclaveRow, { entry, onError })),
  Folio: (entry) =>
    renderToStaticMarkup(
      createElement(FolioLine, {
        row: {
          key: 'r1',
          notes: [],
          prose: null,
          error: entry.kind === 'error' ? entry : null
        },
        pen: false,
        first: 0,
        reading: null,
        onError
      })
    )
}
/** The look each skin gives a neutral fact of a turn, which the line takes. */
const QUIET_LOOK: Record<string, string> = {
  Chat: `<div class="chat-notice" data-tone="quiet" role="status">${NOT_SENT}</div>`,
  Enclave: `<div class="chat-notice" data-tone="quiet" role="status">${NOT_SENT}</div>`,
  Folio: `<p class="folio-aside" data-tone="quiet" role="status">${NOT_SENT}</p>`
}

describe('the not-sent line is a quiet line, not a failure (PRDCT-4566)', () => {
  it('the notice keeps its words and is marked quiet; a failure is not', () => {
    expect(quiet).toEqual({ kind: 'error', message: NOT_SENT, at: 1, quiet: true })
    expect(failure).toEqual({ kind: 'error', message: FAILED, at: 1 })
  })

  for (const skin of Object.keys(skins))
    it(`${skin}: the line in the quiet look of a neutral fact, a failure still in the red`, () => {
      const line = skins[skin](quiet)
      expect(line).toContain(QUIET_LOOK[skin])
      expect(line).not.toContain('data-tone="error"')
      expect(line).not.toContain('role="alert"')
      expect(skins[skin](failure)).toContain(
        `<div class="chat-notice" data-tone="error" role="alert">${FAILED}</div>`
      )
    })

  it('answers nothing: Escape before any answer keeps the message taken back', () => {
    // The turn's message taken back by Escape, then the stop's line for the
    // other tab's message that waited behind it.
    const taken = reduceConversation(
      run([
        { type: 'user_message', text: 'go' },
        { type: 'state_change', state: 'working' }
      ]),
      { withdraw: true }
    )
    const shown = (state: Conversation): string[] =>
      visibleEntries(state.entries).flatMap((e) => (e.kind === 'user' ? [e.text] : []))
    const stop = (notice: SessionEvent): Conversation =>
      run([notice, { type: 'turn_interrupted' }, { type: 'state_change', state: 'done' }], taken)
    const stopped = stop({ type: 'error', message: NOT_SENT, fatal: false, quiet: true })
    expect(answeredSince(stopped.entries)).toBe(false)
    expect(shown(stopped)).toEqual([])
    expect(stopped.entries.at(-1)).toMatchObject({ kind: 'error', message: NOT_SENT })
    // A failure still answers: the message shows again, as before.
    const failed = stop({ type: 'error', message: FAILED, fatal: false })
    expect(answeredSince(failed.entries)).toBe(true)
    expect(shown(failed)).toEqual(['go'])
  })

  it('refuses no model switch: a pick stands across the line, a failure reverts it', () => {
    const picked = reduceConversation(
      run([{ type: 'session_meta', model: 'one', providerSessionId: null }]),
      { pickModel: 'two' }
    )
    expect(
      run([{ type: 'error', message: NOT_SENT, fatal: false, quiet: true }], picked).pendingModel
    ).toBe('two')
    expect(run([{ type: 'error', message: FAILED, fatal: false }], picked).pendingModel).toBeNull()
  })
})
