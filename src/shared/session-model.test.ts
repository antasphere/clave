import { describe, expect, it } from 'vitest'
import { SessionEventSchema, SessionSchema, SessionStreamSchema } from './session-model'

describe('session model v1', () => {
  const events = [
    { type: 'user_message', text: 'hello' },
    { type: 'assistant_text', delta: 'hi', final: false },
    { type: 'assistant_text', delta: '', final: true },
    { type: 'tool_call', id: 'call', name: 'read', input: { path: 'README.md' } },
    { type: 'tool_result', id: 'call', output: { content: 'hello' } },
    {
      type: 'permission_request',
      id: 'permission',
      description: 'Allow?',
      options: [{ id: 'allow', label: 'Allow' }]
    },
    { type: 'state_change', state: 'blocked' },
    { type: 'provider_event', provider: 'echo', payload: { arbitrary: [1, null, 'text'] } }
  ]
  it.each(events)('validates $type and its event stream', (event) => {
    expect(SessionEventSchema.parse(event)).toEqual(event)
    expect(SessionStreamSchema.parse({ kind: 'event', event })).toEqual({ kind: 'event', event })
  })
  it('preserves unknown provider payload by identity', () => {
    const payload = { nested: { arbitrary: Symbol('provider value') } }
    const event = SessionEventSchema.parse({ type: 'provider_event', provider: 'future', payload })
    expect(event.type === 'provider_event' && event.payload).toBe(payload)
  })
  it('validates bytes without converting them to text', () => {
    const data = new Uint8Array([0, 255, 128])
    expect(SessionStreamSchema.parse({ kind: 'pty', data })).toEqual({ kind: 'pty', data })
    expect(SessionStreamSchema.safeParse({ kind: 'pty', data: 'text' }).success).toBe(false)
  })
  it.each([
    { type: 'assistant_text', delta: 'hello' },
    { type: 'state_change', state: 'invented' },
    { type: 'user_message', text: 42 },
    { type: 'tool_call', id: 'x', input: {} },
    { type: 'permission_request', id: 'x', description: '?', options: ['allow'] },
    { type: 'unrecognized' }
  ])('rejects malformed $type', (event) => {
    expect(SessionEventSchema.safeParse(event).success).toBe(false)
  })
  it('rejects invalid session metadata', () => {
    expect(SessionSchema.safeParse({ id: 'x', transport: 'http' }).success).toBe(false)
  })
})
