import recordedEcho from '../../../../plugins/chat-view/fixtures/echo.json'
import { SessionEventSchema } from '../../../shared/session-model'
import { describe, expect, it } from 'vitest'
import {
  emptyConversation,
  reduceConversation,
  type Conversation,
  type ChatEvent
} from '../../../../plugins/chat-view/src/reducer'
const run = (events: ChatEvent[]): Conversation =>
  events.reduce((state, event) => reduceConversation(state, { event, at: 1 }), emptyConversation)
const elsewhere = (entry: Conversation['entries'][number]): boolean | undefined =>
  entry.kind === 'permission' ? entry.answeredElsewhere : undefined
describe('conversation stream', () => {
  it('renders the recorded echo sequence in order and correlates its tool', () => {
    const state = run(recordedEcho.map((event) => SessionEventSchema.parse(event)))
    expect(state.state).toBe('done')
    expect(state.entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'tool'])
    expect(state.entries[2]).toMatchObject({
      id: recordedEcho[3].id,
      input: { text: 'hello' },
      output: 'hello',
      complete: true
    })
  })
  it('handles every vocabulary event, streaming boundaries and an early tool result', () => {
    let state = run([
      { type: 'session_meta', model: 'fixture', providerSessionId: 'provider-id' },
      { type: 'assistant_text', delta: 'one ', final: false },
      { type: 'assistant_text', delta: 'two', final: false },
      { type: 'assistant_text', delta: '', final: true },
      { type: 'tool_result', id: 'early', output: { ok: true } },
      { type: 'tool_call', id: 'early', name: 'Read', input: '/tmp/file' },
      {
        type: 'permission_request',
        id: 'p',
        description: 'Allow?',
        toolName: 'Write',
        input: {},
        options: [{ id: 'yes', label: 'Allow' }]
      },
      { type: 'provider_event', provider: 'fixture', payload: { raw: true } },
      { type: 'error', message: 'recoverable', fatal: false }
    ])
    expect(state.model).toBe('fixture')
    expect(state.state).toBe('blocked')
    expect(state.entries[0]).toMatchObject({ text: 'one two', final: true })
    expect(state.entries[1]).toMatchObject({ name: 'Read', output: { ok: true }, complete: true })
    state = reduceConversation(state, { answer: 'p', optionId: 'yes' })
    expect(state.entries[2]).toMatchObject({ answer: 'yes' })
    expect(state.state).toBe('working')
    // A provider's own wire event never becomes a transcript entry.
    expect(state.entries.map((e) => e.kind)).toEqual(['assistant', 'tool', 'permission', 'error'])
    expect(reduceConversation(state, { exit: 7 })).toMatchObject({ state: 'ended', exitCode: 7 })
    expect(run([{ type: 'error', message: 'fatal', fatal: true }]).state).toBe('ended')
  })
  it('marks a request answered elsewhere when the kernel leaves blocked without this view', () => {
    const request = {
      type: 'permission_request' as const,
      id: 'p',
      description: 'Allow?',
      toolName: 'Write',
      input: {},
      options: [
        { id: 'yes', label: 'Allow' },
        { id: 'no', label: 'Deny' }
      ]
    }
    let state = run([request])
    expect(state.state).toBe('blocked')
    expect(state.entries[0]).toMatchObject({ kind: 'permission' })
    expect(elsewhere(state.entries[0])).toBe(undefined)
    // Another consumer answered: the kernel says working, so the request is no
    // longer outstanding and this view's card must stop offering a click.
    state = reduceConversation(state, { event: { type: 'state_change', state: 'working' } })
    expect(state.state).toBe('working')
    expect(elsewhere(state.entries[0])).toBe(true)
    expect(state.entries[0]).toMatchObject({ kind: 'permission' })
    expect((state.entries[0] as { answer?: string }).answer).toBe(undefined)
  })
  it('keeps a pending request open while the kernel stays blocked, and on ended', () => {
    const request = {
      type: 'permission_request' as const,
      id: 'p',
      description: 'Allow?',
      toolName: 'Write',
      input: {},
      options: [{ id: 'yes', label: 'Allow' }]
    }
    const blocked = reduceConversation(run([request]), {
      event: { type: 'state_change', state: 'blocked' }
    })
    expect(elsewhere(blocked.entries[0])).toBe(undefined)
    const ended = reduceConversation(blocked, { event: { type: 'state_change', state: 'ended' } })
    expect(ended.state).toBe('ended')
    expect(elsewhere(ended.entries[0])).toBe(undefined)
  })
  it('never relabels a request this view answered itself', () => {
    const request = {
      type: 'permission_request' as const,
      id: 'p',
      description: 'Allow?',
      toolName: 'Write',
      input: {},
      options: [{ id: 'yes', label: 'Allow' }]
    }
    let state = reduceConversation(run([request]), { answer: 'p', optionId: 'yes' })
    state = reduceConversation(state, { event: { type: 'state_change', state: 'working' } })
    expect(state.entries[0]).toMatchObject({ answer: 'yes' })
    expect(elsewhere(state.entries[0])).toBe(undefined)
  })
  it('reopens a card it closed when the kernel goes back to blocked', () => {
    const request = {
      type: 'permission_request' as const,
      id: 'p',
      description: 'Allow?',
      toolName: 'Write',
      input: {},
      options: [{ id: 'yes', label: 'Allow' }]
    }
    // Codex emits working on every turn/started, approvals pending or not, and
    // leaves an approval whose turn id is empty in its set: without this, the
    // one request the user must answer would be dead for the session's life.
    let state = reduceConversation(run([request]), {
      event: { type: 'state_change', state: 'working' }
    })
    expect(elsewhere(state.entries[0])).toBe(true)
    state = reduceConversation(state, { event: { type: 'state_change', state: 'blocked' } })
    expect(state.state).toBe('blocked')
    expect(elsewhere(state.entries[0])).toBe(undefined)
    // And the card is answerable again, by this view.
    state = reduceConversation(state, { answer: 'p', optionId: 'yes' })
    expect(state.entries[0]).toMatchObject({ answer: 'yes' })
    expect(state.state).toBe('working')
  })
  it('never reopens a card this view answered itself', () => {
    const request = {
      type: 'permission_request' as const,
      id: 'p',
      description: 'Allow?',
      toolName: 'Write',
      input: {},
      options: [{ id: 'yes', label: 'Allow' }]
    }
    let state = reduceConversation(run([request]), { answer: 'p', optionId: 'yes' })
    state = reduceConversation(state, { event: { type: 'state_change', state: 'blocked' } })
    expect(state.entries[0]).toMatchObject({ answer: 'yes' })
    expect(elsewhere(state.entries[0])).toBe(undefined)
  })
  it('keeps the entries array when a state_change changes nothing in it', () => {
    const state = run([
      { type: 'assistant_text', delta: 'hello', final: true },
      { type: 'tool_call', id: 't', name: 'Read', input: {} }
    ])
    for (const word of ['working', 'done', 'idle', 'blocked', 'ended'] as const) {
      const next = reduceConversation(state, { event: { type: 'state_change', state: word } })
      expect(next.state).toBe(word)
      expect(next.entries).toBe(state.entries)
    }
  })
  it('lets this view answer a second request while the first was answered elsewhere', () => {
    const make = (id: string): ChatEvent => ({
      type: 'permission_request' as const,
      id,
      description: 'Allow?',
      toolName: 'Write',
      input: {},
      options: [{ id: 'yes', label: 'Allow' }]
    })
    let state = run([make('one')])
    state = reduceConversation(state, { event: { type: 'state_change', state: 'working' } })
    state = reduceConversation(state, { event: make('two') })
    expect(state.state).toBe('blocked')
    state = reduceConversation(state, { answer: 'two', optionId: 'yes' })
    // Nothing is outstanding any more: the one answered elsewhere does not hold
    // the conversation on blocked.
    expect(state.state).toBe('working')
    expect(state.entries[0]).toMatchObject({ answeredElsewhere: true })
    expect(state.entries[1]).toMatchObject({ answer: 'yes' })
  })
})
