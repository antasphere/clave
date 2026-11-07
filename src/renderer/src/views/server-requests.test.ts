import { describe, expect, it } from 'vitest'
import { resourceKey } from '@clave/contract/fleet'
import { emptyConversation, reduceConversation } from '../../../../plugins/chat-view/src/reducer'
import {
  liveQuestionCards,
  remoteRequestFor,
  serverDock,
  withServerPending
} from '../../../../plugins/chat-view/src/server-requests'
import type { FleetPendingRequest } from '../../../preload/fleet-types'
import type { SessionEvent } from '../../../shared/session-model'

const session = resourceKey('session', 'server-a', 'agent')
const other = resourceKey('session', 'server-a', 'other')
const record = (
  uuid: string,
  createdAt: number,
  extra: Partial<FleetPendingRequest> = {}
): FleetPendingRequest => ({
  id: resourceKey('request', 'server-a', uuid),
  sessionId: session,
  kind: 'clarification',
  description: `Question ${uuid}`,
  createdAt,
  providerRequestId: '0',
  options: [{ id: 'answer', label: 'Answer' }],
  questions: [{ id: 'value', question: 'Value?', options: [] }],
  toolName: 'item/tool/requestUserInput',
  input: { questions: [{ id: 'value', question: 'Value?', isSecret: true }] },
  ...extra
})

describe('a server session docks the server’s own records', () => {
  it('shows its native requests oldest first, each under the server’s request key', () => {
    const later = record('b', 20)
    const earlier = record('a', 10, { providerRequestId: '"approval"', kind: 'permission' })
    const dock = serverDock([later, earlier], session)
    expect(dock.map((r) => r.id)).toEqual([earlier.id, later.id])
    expect(dock[1]).toEqual({
      type: 'permission_request',
      id: later.id,
      description: 'Question b',
      options: [{ id: 'answer', label: 'Answer' }],
      questions: [{ id: 'value', question: 'Value?', options: [] }],
      toolName: 'item/tool/requestUserInput',
      input: { questions: [{ id: 'value', question: 'Value?', isSecret: true }] }
    })
  })
  it('keeps two requests under one reused provider id apart', () => {
    // A restarted Codex numbers from zero again: two records, one provider id.
    const dock = serverDock([record('a', 10), record('b', 20)], session)
    expect(new Set(dock.map((r) => r.id)).size).toBe(2)
  })
  it('leaves out other sessions’ requests and what agents asked through Clave’s tools', () => {
    const mcp = record('mcp', 5, { providerRequestId: undefined })
    const elsewhere = record('x', 6, { sessionId: other })
    expect(serverDock([mcp, elsewhere], session)).toEqual([])
    expect(serverDock(undefined, session)).toEqual([])
  })
  it('hands the dock copies, never the store’s own arrays', () => {
    const r = record('a', 10)
    const [docked] = serverDock([r], session)
    expect(docked.options).not.toBe(r.options)
    expect(docked.questions).not.toBe(r.questions)
  })
})

describe('a server session’s rows read the server’s list', () => {
  const asked: SessionEvent = {
    type: 'permission_request',
    id: '"approval-1"',
    description: 'Run a command',
    options: [{ id: 'accept', label: 'Accept' }]
  }
  const entries = reduceConversation(emptyConversation, { event: asked }).entries
  it('marks an unanswered request the server no longer holds as answered elsewhere', () => {
    expect(withServerPending(entries, [], session)[0]).toMatchObject({ answeredElsewhere: true })
    const held = [record('a', 1, { providerRequestId: '"approval-1"' })]
    expect(withServerPending(entries, held, session)[0]).toMatchObject({
      answeredElsewhere: false
    })
  })
  it('leaves a local session’s own reading untouched', () => {
    expect(withServerPending(entries, undefined, session)).toBe(entries)
  })
})

describe('one card per request still waiting (PRDCT-4157)', () => {
  const ask = (id: string): SessionEvent => ({
    type: 'permission_request',
    id,
    description: `Question ${id}`,
    options: [{ id: 'answer', label: 'Answer' }],
    questions: [{ id: 'value', question: 'Value?', options: [] }]
  })
  const entriesOf = (...events: SessionEvent[]): typeof emptyConversation.entries =>
    events.reduce((state, event) => reduceConversation(state, { event, at: 1 }), emptyConversation)
      .entries
  it('draws the latest entry of a provider id, never an earlier one under the same id', () => {
    // Codex numbers its requests from zero in every process: a dead
    // process's first question and the live one share "0".
    const entries = entriesOf(ask('0'), { type: 'user_message', text: 'again' }, ask('1'))
    const stale = {
      ...entries[0],
      request: { ...(entries[0] as never as { request: object }).request }
    }
    const list = [stale as never, ...entries.slice(1), { ...entries[0] }] as typeof entries
    const live = liveQuestionCards(list, undefined, 'local')
    expect(live.has(list[3])).toBe(true)
    expect(live.has(list[0])).toBe(false)
    expect(live.has(list[2])).toBe(true)
  })
  it("a server session's cards are the server's records for that session alone", () => {
    const entries = entriesOf(ask('0'), ask('7'))
    const pending = [
      record('a1', 1, { providerRequestId: '0' }),
      record('b1', 2, { providerRequestId: '7', sessionId: other })
    ]
    const live = liveQuestionCards(entries, pending, session)
    expect(live.has(entries[0])).toBe(true)
    expect(live.has(entries[1])).toBe(false)
  })
  it('an answered or settled entry is never a card', () => {
    const entries = entriesOf(ask('0'))
    const answered = [{ ...entries[0], answer: 'answer' }] as typeof entries
    expect(liveQuestionCards(answered, undefined, 'local').size).toBe(0)
    const elsewhere = [{ ...entries[0], answeredElsewhere: true }] as typeof entries
    expect(liveQuestionCards(elsewhere, undefined, 'local').size).toBe(0)
  })
  it('an older entry under an answered id never comes back to life', () => {
    // The reducer keeps one entry per id; a new process re-using "0" is read
    // from the past as a second entry, built here by hand.
    const entries = entriesOf(ask('0'), { type: 'user_message', text: 'again' })
    const list = [entries[0], entries[1], { ...entries[0], answer: 'answer' }] as typeof entries
    expect(liveQuestionCards(list, undefined, 'local').size).toBe(0)
    const open = [{ ...entries[0], answer: 'answer' }, entries[1], entries[0]] as typeof entries
    expect(liveQuestionCards(open, undefined, 'local').has(open[2])).toBe(true)
  })
  it("a card answers its own session's record, by the server's key or the provider's id", () => {
    const pending = [
      record('a1', 1, { providerRequestId: '0' }),
      record('b1', 2, { providerRequestId: '0', sessionId: other })
    ]
    expect(remoteRequestFor(pending, other, '0')?.id).toBe(pending[1].id)
    expect(remoteRequestFor(pending, session, '0')?.id).toBe(pending[0].id)
    expect(remoteRequestFor(pending, session, pending[1].id)).toBeUndefined()
    expect(remoteRequestFor(pending, 'nobody', '0')).toBeUndefined()
    expect(remoteRequestFor(undefined, session, '0')).toBeUndefined()
  })
})
