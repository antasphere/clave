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
  it('keeps what a user message attached, and adds nothing to one that attached nothing', () => {
    const shot = {
      id: 'shot',
      path: '/pictures/shot.png',
      name: 'shot.png',
      mimeType: 'image/png',
      size: 3,
      delivery: 'image' as const
    }
    const state = run([
      { type: 'user_message', text: '', attachments: [shot] },
      { type: 'user_message', text: 'plain' },
      { type: 'user_message', text: 'empty list', attachments: [] }
    ])
    expect(state.entries[0]).toEqual({
      kind: 'user',
      text: '',
      final: true,
      at: 1,
      attachments: [shot]
    })
    expect(state.entries[1]).toEqual({ kind: 'user', text: 'plain', final: true, at: 1 })
    expect('attachments' in state.entries[2]).toBe(false)
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
  it('mutes the message whose turn was interrupted and closes the answer as it stands', () => {
    const state = run([
      { type: 'user_message', text: 'first' },
      { type: 'assistant_text', delta: 'done', final: true },
      { type: 'user_message', text: 'count to 400' },
      { type: 'assistant_text', delta: '1\n2\n3', final: false },
      { type: 'turn_interrupted' },
      { type: 'state_change', state: 'done' }
    ])
    expect(state.entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(state.entries[0]).toMatchObject({ text: 'first' })
    expect(state.entries[0]).not.toHaveProperty('interrupted')
    expect(state.entries[2]).toMatchObject({ text: 'count to 400', interrupted: true })
    expect(state.entries[3]).toMatchObject({ text: '1\n2\n3', final: true })
    expect(state.entries.some((e) => e.kind === 'error')).toBe(false)
    expect(state.state).toBe('done')
  })
  it('an interruption with no message to mute changes nothing', () => {
    const state = run([{ type: 'assistant_text', delta: 'hello', final: true }])
    const next = reduceConversation(state, { event: { type: 'turn_interrupted' } })
    expect(next.entries).toEqual(state.entries)
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
  it('puts a page of the past in front without moving a key already given', () => {
    const past: ChatEvent[] = [
      { type: 'user_message', text: 'old question' },
      { type: 'tool_call', id: 't', name: 'Read', input: {} },
      { type: 'tool_result', id: 't', output: 'ok' },
      { type: 'assistant_text', delta: 'old answer', final: true }
    ]
    const live = run([{ type: 'user_message', text: 'new question' }])
    const keyOf = (c: Conversation, text: string): number =>
      c.first + c.entries.findIndex((e) => e.kind === 'user' && e.text === text)
    const before = keyOf(live, 'new question')
    const merged = reduceConversation(live, {
      prepend: past.map((event, i) => ({ event, at: 100 + i }))
    })
    // The same entries as reading the whole conversation in order, each of
    // the past dated by its transcript line, and the live one keeps its key.
    const whole = run([...past, { type: 'user_message', text: 'new question' }])
    const undated = (c: Conversation): unknown[] => c.entries.map((e) => ({ ...e, at: 0 }))
    expect(undated(merged)).toEqual(undated(whole))
    expect(merged.entries.map((e) => e.at)).toEqual([100, 101, 103, 1])
    expect(keyOf(merged, 'new question')).toBe(before)
    expect(merged.first).toBe(live.first - 3)
    expect(reduceConversation(merged, { prepend: [] })).toBe(merged)
  })
})
