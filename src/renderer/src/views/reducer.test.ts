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
    expect(state.entries.map((e) => e.kind)).toEqual([
      'assistant',
      'tool',
      'permission',
      'raw',
      'error'
    ])
    expect(reduceConversation(state, { exit: 7 })).toMatchObject({ state: 'ended', exitCode: 7 })
    expect(run([{ type: 'error', message: 'fatal', fatal: true }]).state).toBe('ended')
  })
})
