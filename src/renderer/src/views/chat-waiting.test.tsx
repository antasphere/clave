/**
 * The messages that wait for the agent (PRDCT-4566): an OpenCode or a Pi
 * chat lists what was written while the agent works and has not taken yet;
 * the view draws them in a stack above the composer, never in the
 * transcript, until each enters the conversation as its own message, the
 * moment the agent takes it. What leaves unsent comes back to the composer.
 */
import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@clave/ui/components'
import type { SessionEvent, WaitingMessage } from '../../../shared/session-model'
import {
  emptyConversation,
  reduceConversation,
  type Conversation
} from '../../../../plugins/chat-view/src/reducer'
import { groupEntries, visibleEntries } from '../../../../plugins/chat-view/src/tools'
import {
  draftWithReturned,
  filesWithReturned,
  sendsWhileWorking,
  startedTurn,
  takenBack,
  takesLine,
  type WaitingReturn
} from '../../../../plugins/chat-view/src/waiting'
import { WaitingStack } from '../../../../plugins/chat-view/src/WaitingStack'

Object.assign(globalThis, { React })

const run = (events: SessionEvent[], from: Conversation = emptyConversation): Conversation =>
  events.reduce((state, event) => reduceConversation(state, { event, at: 1 }), from)
const waiting = (
  messages: WaitingMessage[],
  returned?: WaitingReturn,
  takes: 'turn' | 'step' = 'turn'
): SessionEvent => ({
  type: 'waiting_messages',
  messages,
  takes,
  ...(returned ? { returned } : {})
})
const LANE_B =
  '[Message from Clave tab "Lane B" — reply with clave_send_to_session sessionId="tab-b"]\nThe tests pass on my side.'
const file = {
  id: 'f1',
  path: '/tmp/notes.md',
  name: 'notes.md',
  mimeType: 'text/markdown',
  size: 3,
  delivery: 'reference' as const
}
const userTexts = (state: Conversation): string[] =>
  state.entries.flatMap((e) => (e.kind === 'user' ? [e.text] : []))

describe('the conversation holds only what the agent has taken (PRDCT-4566)', () => {
  it('a waiting message is the stack’s, never an entry; taken, it enters after the answer before it', () => {
    let state = run([
      { type: 'user_message', text: 'first' },
      { type: 'state_change', state: 'working' },
      { type: 'assistant_text', delta: 'Working on the first', final: false },
      waiting([{ id: 'w1', text: 'second' }])
    ])
    expect(state.waiting).toEqual([{ id: 'w1', text: 'second' }])
    expect(state.takes).toBe('turn')
    expect(userTexts(state)).toEqual(['first'])
    // The running turn's text goes on: it stays the first message's answer.
    state = run(
      [
        { type: 'assistant_text', delta: ', still.', final: false },
        { type: 'assistant_text', delta: '', final: true },
        { type: 'state_change', state: 'done' },
        waiting([]),
        { type: 'user_message', text: 'second' },
        { type: 'state_change', state: 'working' },
        { type: 'assistant_text', delta: 'Now the second', final: false }
      ],
      state
    )
    expect(state.waiting).toEqual([])
    expect(
      state.entries.map((e) => (e.kind === 'user' || e.kind === 'assistant' ? e.text : e.kind))
    ).toEqual(['first', 'Working on the first, still.', 'second', 'Now the second'])
  })

  it('what was handed back is a new value at each return; the list stays as the adapter says', () => {
    const returned: WaitingReturn = { why: 'withdrawn', messages: [{ id: 'w1', text: 'two' }] }
    const state = run([waiting([{ id: 'w2', text: 'three' }], returned)])
    expect(state.waiting).toEqual([{ id: 'w2', text: 'three' }])
    expect(state.returned).toEqual(returned)
    const again = run(
      [waiting([], { why: 'stopped', messages: [{ id: 'w2', text: 'three' }] })],
      state
    )
    expect(again.returned).not.toBe(state.returned)
    expect(again.returned?.why).toBe('stopped')
    // A list with nothing handed back keeps the last return as it was.
    expect(run([waiting([])], again).returned).toBe(again.returned)
  })

  it('a page of the past never shows a list nor hands anything back again', () => {
    const live = run([waiting([{ id: 'w2', text: 'still waiting' }])])
    const stale = [
      { event: { type: 'user_message', text: 'first' } as SessionEvent },
      {
        event: waiting([], { why: 'stopped', messages: [{ id: 'w1', text: 'gone' }] })
      }
    ]
    const synced = reduceConversation(live, { sync: stale })
    expect(synced.waiting).toBe(live.waiting)
    expect(synced.returned).toBe(live.returned)
    expect(userTexts(synced)).toEqual(['first'])
    const prepended = reduceConversation(live, { prepend: stale })
    expect(prepended.waiting).toBe(live.waiting)
    expect(prepended.returned).toBe(live.returned)
  })

  it('nothing waits once the process has ended', () => {
    const listed = run([waiting([{ id: 'w1', text: 'two' }])])
    expect(run([{ type: 'state_change', state: 'ended' }], listed).waiting).toEqual([])
    expect(reduceConversation(listed, { exit: 1 }).waiting).toEqual([])
  })

  it('a delivered message waits under its tab’s name, then enters as that tab’s card, never as the reader’s', () => {
    const waited = run([
      { type: 'user_message', text: 'first' },
      { type: 'state_change', state: 'working' },
      waiting([{ id: 'w1', text: LANE_B }])
    ])
    const markup = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(WaitingStack, {
          messages: waited.waiting,
          takes: waited.takes,
          agent: 'OpenCode',
          onWithdraw: () => {}
        })
      )
    )
    expect(markup).toContain('<span class="chat-waiting-from">Lane B</span>')
    expect(markup).toContain('The tests pass on my side.')
    expect(markup).not.toContain('[Message from Clave tab')
    const taken = run(
      [
        { type: 'state_change', state: 'done' },
        waiting([]),
        { type: 'user_message', text: LANE_B }
      ],
      waited
    )
    const blocks = groupEntries(visibleEntries(taken.entries))
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'delivery-group'])
  })
})

describe('the stack above the composer (PRDCT-4566)', () => {
  const draw = (
    messages: WaitingMessage[],
    takes: 'turn' | 'step' | null,
    agent = 'OpenCode'
  ): string =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(WaitingStack, { messages, takes, agent, onWithdraw: () => {} })
      )
    )

  it('draws nothing while nothing waits', () => {
    expect(draw([], 'turn')).toBe('')
  })

  it('one row per message in the order written, each with when it goes and a withdraw', () => {
    const markup = draw(
      [
        { id: 'w1', text: 'and the tests too\nthen the docs' },
        { id: 'w2', text: '[Message from a Clave agent]\nA word from an unnamed tab' },
        { id: 'w3', text: '', attachments: [file] }
      ],
      'turn'
    )
    expect(markup).toContain('data-waiting-stack=""')
    expect([...markup.matchAll(/data-waiting-message="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'w1',
      'w2',
      'w3'
    ])
    expect(markup.match(/data-waiting-withdraw=""/g)).toHaveLength(3)
    expect(markup.match(/aria-label="Withdraw"/g)).toHaveLength(3)
    expect(markup.match(/Sent when this turn ends/g)).toHaveLength(3)
    // One line: the first line of a longer message; the name of an unnamed
    // tab as the delivery card says it; a file alone by its name.
    expect(markup).toContain('<span class="chat-waiting-gist">and the tests too</span>')
    expect(markup).toContain('<span class="chat-waiting-from">Another agent</span>')
    expect(markup).toContain('<span class="chat-waiting-gist">notes.md</span>')
    expect(markup).toContain('aria-label="3 messages waiting"')
  })

  it('says when Pi takes one', () => {
    expect(draw([{ id: 'w1', text: 'next' }], 'step', 'Pi')).toContain(
      'Pi takes it at its next step'
    )
    expect(takesLine('step', 'Pi')).toBe('Pi takes it at its next step')
    expect(takesLine('turn', 'OpenCode')).toBe('Sent when this turn ends')
  })
})

describe('what leaves unsent comes back to the composer (PRDCT-4566)', () => {
  const two: WaitingReturn = {
    why: 'stopped',
    messages: [
      { id: 'w1', text: 'second thought' },
      { id: 'w2', text: 'and a third\n' }
    ]
  }

  it('a stop hands every waiting message back, joined in order with a blank line', () => {
    expect(draftWithReturned('', two)).toBe('second thought\n\nand a third')
    // After the message the take-back put there, or what was being typed.
    expect(draftWithReturned('the first', two)).toBe('the first\n\nsecond thought\n\nand a third')
    // Every view of the session writes the one draft: never twice.
    const once = draftWithReturned('the first', two)
    expect(draftWithReturned(once, two)).toBe(once)
    expect(draftWithReturned('', { ...two, why: 'ended' })).toBe('second thought\n\nand a third')
  })

  it('a withdrawn message comes back only into an empty composer, as the take-back does', () => {
    const one: WaitingReturn = { why: 'withdrawn', messages: [{ id: 'w1', text: 'never mind' }] }
    expect(draftWithReturned('', one)).toBe('never mind')
    expect(draftWithReturned('  ', one)).toBe('never mind')
    expect(draftWithReturned('something new', one)).toBe('something new')
  })

  it('files come back with their message, once', () => {
    const withFile: WaitingReturn = {
      why: 'withdrawn',
      messages: [{ id: 'w1', text: 'look', attachments: [file] }]
    }
    expect(filesWithReturned([], 'look', withFile)).toEqual([file])
    // The composer held something else: the withdrawn message was dropped.
    expect(filesWithReturned([], 'something new', withFile)).toBeNull()
    const stopped: WaitingReturn = { ...withFile, why: 'stopped' }
    const other = { ...file, id: 'f0', name: 'other.md' }
    expect(filesWithReturned([other], 'x', stopped)).toEqual([other, file])
    expect(filesWithReturned([other, file], 'x', stopped)).toBeNull()
    expect(filesWithReturned([], '', { why: 'stopped', messages: [] })).toBeNull()
  })

  it('Escape hands back the message the turn started on, not the last one sent', () => {
    const state = run([
      { type: 'user_message', text: 'first', attachments: [file] },
      { type: 'state_change', state: 'working' },
      waiting([{ id: 'w1', text: 'second' }])
    ])
    expect(startedTurn(state.entries)).toEqual({ text: 'first', attachments: [file] })
    expect(startedTurn([])).toBeNull()
  })

  // Verifier 3, finding 8 (M30): what each view's Escape takes back, so that
  // the turn's own message is never lost and no waiting text comes back twice.
  it('Escape before any answer, messages waiting: the turn’s own message is taken back, never the last one sent', () => {
    const lastSent = { text: 'third, waiting', attachments: [] }
    const state = run([
      { type: 'user_message', text: 'first', attachments: [file] },
      { type: 'state_change', state: 'working' },
      waiting([
        { id: 'w1', text: 'second, waiting' },
        { id: 'w2', text: 'third, waiting' }
      ])
    ])
    expect(takenBack(state.entries, true, lastSent)).toEqual({
      withdraw: true,
      message: { text: 'first', attachments: [file] }
    })
    // With none waiting, the view's own last message sent, as before.
    expect(takenBack(state.entries, false, lastSent)).toEqual({ withdraw: true, message: lastSent })
    // Once an answer has begun, nothing is taken back.
    const answered = run([{ type: 'assistant_text', delta: 'On it', final: false }], state)
    expect(takenBack(answered.entries, true, lastSent)).toEqual({ withdraw: false, message: null })
    // The take-back, then the stop's return: each text once, in order.
    const draft = draftWithReturned('first', {
      why: 'stopped',
      messages: [
        { id: 'w1', text: 'second, waiting' },
        { id: 'w2', text: 'third, waiting' }
      ]
    })
    expect(draft).toBe('first\n\nsecond, waiting\n\nthird, waiting')
  })
})

// As ruled: while a turn runs, a draft goes with the send button in an
// OpenCode or a Pi chat as in a Codex one (every view's `showInterrupt`).
describe('the send button while the agent works (PRDCT-4566)', () => {
  it('sends the draft in a Codex, an OpenCode or a Pi chat; any other keeps the stop', () => {
    expect(['codex', 'opencode', 'pi'].map(sendsWhileWorking)).toEqual([true, true, true])
    expect(['claude', 'echo'].map(sendsWhileWorking)).toEqual([false, false])
  })
})

// Verifier 3, finding 3, as ruled: a message from another tab never goes into
// the person's composer.
describe('another tab’s message never goes into the composer (PRDCT-4566)', () => {
  it('a turn started on another tab’s message: Escape leaves it where it is and takes nothing back', () => {
    const state = run([
      { type: 'user_message', text: LANE_B },
      { type: 'state_change', state: 'working' },
      waiting([{ id: 'w1', text: 'mine, waiting' }])
    ])
    expect(startedTurn(state.entries)).toBeNull()
    expect(takenBack(state.entries, true, { text: 'an older one', attachments: [] })).toEqual({
      withdraw: false,
      message: null
    })
  })

  it('handed back with the person’s own, another tab’s message is left out of the composer', () => {
    const back: WaitingReturn = {
      why: 'stopped',
      messages: [
        { id: 'w1', text: 'mine' },
        { id: 'w2', text: LANE_B },
        { id: 'w3', text: '[Message from a Clave agent]\nunnamed' }
      ]
    }
    expect(draftWithReturned('', back)).toBe('mine')
    expect(
      draftWithReturned('', { why: 'withdrawn', messages: [{ id: 'w2', text: LANE_B }] })
    ).toBe('')
  })
})
