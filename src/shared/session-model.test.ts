import { describe, expect, it } from 'vitest'
import {
  ModelOptionSchema,
  SessionEventSchema,
  SessionInputSchema,
  SessionSchema,
  SessionStreamSchema,
  SetEffortSchema
} from './session-model'

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
    { type: 'effort', effort: 'high' },
    { type: 'effort', effort: null },
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
    { type: 'effort' },
    { type: 'effort', effort: 3 },
    { type: 'permission_request', id: 'x', description: '?', options: ['allow'] },
    { type: 'unrecognized' }
  ])('rejects malformed $type', (event) => {
    expect(SessionEventSchema.safeParse(event).success).toBe(false)
  })
  it('rejects invalid session metadata', () => {
    expect(SessionSchema.safeParse({ id: 'x', transport: 'http' }).success).toBe(false)
  })
  it('accepts an effort switch in the provider word, and refuses anything else', () => {
    for (const effort of ['low', 'xhigh', 'ultra'])
      expect(SessionInputSchema.parse({ type: 'set_effort', effort })).toEqual({
        type: 'set_effort',
        effort
      })
    for (const effort of ['', 'High', '--x', 'high;rm', 'high rm'])
      expect(SetEffortSchema.safeParse({ type: 'set_effort', effort }).success).toBe(false)
    expect(SetEffortSchema.safeParse({ type: 'set_effort', effort: null }).success).toBe(false)
    expect(SessionInputSchema.safeParse({ type: 'set_effort', effort: '--x' }).success).toBe(false)
  })
  it('lists the efforts a model takes, and its default, as optional', () => {
    const option = {
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      efforts: [
        { id: 'low', label: 'Low', hint: 'Fast' },
        { id: 'high', label: 'High' }
      ],
      defaultEffort: 'low'
    }
    expect(ModelOptionSchema.parse(option)).toEqual(option)
    expect(ModelOptionSchema.parse({ id: 'm', label: 'M' })).toEqual({ id: 'm', label: 'M' })
    expect(ModelOptionSchema.safeParse({ ...option, efforts: [{ id: 'low' }] }).success).toBe(false)
  })
})
