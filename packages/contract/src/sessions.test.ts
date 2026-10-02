import { describe, expect, it } from 'vitest'
import { Either, Schema } from 'effect'
import { z } from 'zod'
import {
  SessionSchema as ZodSession,
  SessionEventSchema as ZodSessionEvent,
  SessionInputSchema as ZodSessionInput
} from '../../../src/shared/session-model'
import {
  Attachments,
  Session,
  SessionEvent,
  SessionInput,
  SessionStream,
  SessionWrite
} from './sessions'

const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown): Either.Either<A, string> =>
  Either.mapLeft(Schema.decodeUnknownEither(schema)(input), (e) => e.message)

const session = {
  id: 's1',
  provider: 'claude',
  transport: 'events',
  cwd: '/work',
  windowKey: 'w1',
  state: 'idle',
  createdAt: 1,
  adapterId: 'claude-chat',
  title: 'A tab'
}

/** Every zod example the renderer accepts, this contract accepts too, and the
 *  other way round: the two copies of the model are one wire. */
const inputs: unknown[] = [
  { type: 'user_message', text: 'hello' },
  {
    type: 'user_message',
    text: 'see',
    attachments: [
      {
        id: 'a',
        path: '/tmp/x.png',
        name: 'x.png',
        mimeType: 'image/png',
        size: 3,
        delivery: 'image'
      }
    ]
  },
  { type: 'permission_response', id: 'p1', optionId: 'allow-once' },
  { type: 'permission_response', id: 'p1', optionId: 'answer', answers: { q: 'yes' } },
  { type: 'interrupt' },
  { type: 'set_model', model: null },
  { type: 'set_model', model: 'opus' },
  { type: 'set_effort', effort: 'xhigh' },
  { type: 'set_permission_mode', mode: 'plan' },
  { type: 'stop_task', taskId: 't1' }
]
const rejectedInputs: unknown[] = [
  { type: 'set_effort', effort: '--dangerously' },
  { type: 'stop_task', taskId: '' },
  { type: 'user_message' },
  { type: 'nope' }
]
const events: unknown[] = [
  { type: 'assistant_text', delta: 'hi', final: false },
  { type: 'tool_call', id: 't', name: 'Read', input: { path: 'x' }, parent: 'p' },
  { type: 'tool_result', id: 't', output: 'ok', error: false },
  {
    type: 'permission_request',
    id: 'p',
    description: 'Run it?',
    options: [{ id: 'allow-once', label: 'Allow once' }],
    questions: [{ question: 'Which?', options: [{ label: 'A' }], multiSelect: true }]
  },
  { type: 'state_change', state: 'working' },
  { type: 'session_meta', model: 'opus', providerSessionId: null },
  { type: 'effort', effort: null },
  { type: 'error', message: 'boom', fatal: false },
  { type: 'turn_interrupted' },
  { type: 'context_usage', used: 10, window: 200, parent: 'p' },
  { type: 'subagent_model', parent: 'p', model: 'sonnet' },
  { type: 'permission_mode', mode: 'default', modes: [{ id: 'default', label: 'Default' }] },
  {
    type: 'background_tasks',
    tasks: [{ id: 'b', kind: 'shell', description: 'build', startedAt: 1 }]
  },
  { type: 'provider_event', provider: 'claude', payload: { any: 1 } }
]

describe('the ported session model agrees with the zod one', () => {
  it('accepts the same session record', () => {
    expect(ZodSession.safeParse(session).success).toBe(true)
    expect(Either.isRight(decode(Session, session))).toBe(true)
    expect(Either.isRight(decode(Session, { ...session, id: '' }))).toBe(false)
    expect(ZodSession.safeParse({ ...session, id: '' }).success).toBe(false)
  })
  it.each(inputs.map((input) => [JSON.stringify(input), input]))('accepts input %s', (_, input) => {
    expect(ZodSessionInput.safeParse(input).success).toBe(true)
    expect(decode(SessionInput, input)).toEqual(Either.right(input))
  })
  it.each(rejectedInputs.map((input) => [JSON.stringify(input), input]))(
    'rejects input %s on both sides',
    (_, input) => {
      expect(ZodSessionInput.safeParse(input).success).toBe(false)
      expect(Either.isLeft(decode(SessionInput, input))).toBe(true)
    }
  )
  it.each(events.map((event) => [JSON.stringify(event), event]))('accepts event %s', (_, event) => {
    expect(ZodSessionEvent.safeParse(event).success).toBe(true)
    expect(decode(SessionEvent, event)).toEqual(Either.right(event))
  })
  it('covers every event type the zod union names, and no other', () => {
    const zodTypes = ZodSessionEvent.options.map(
      (o) => (o.shape.type as z.ZodLiteral<string>).value
    )
    const ours = SessionEvent.members.map(
      (m) => (m.fields.type as Schema.Literal<[string]>).literals[0]
    )
    expect([...ours].sort()).toEqual([...zodTypes].sort())
  })
  it('refuses more than ten attachments, as the renderer does', () => {
    const one = {
      id: 'a',
      path: '/p',
      name: 'n',
      mimeType: 'text/plain',
      size: 0,
      delivery: 'reference'
    }
    expect(Either.isRight(decode(Attachments, Array(10).fill(one)))).toBe(true)
    expect(Either.isLeft(decode(Attachments, Array(11).fill(one)))).toBe(true)
  })
})

describe('the session stream on the wire', () => {
  it('carries terminal bytes as base64 and gives them back as bytes', () => {
    const bytes = new Uint8Array([0x1b, 0x5b, 0x48, 0xc3, 0xa9])
    const encoded = Schema.encodeSync(SessionStream)({ kind: 'pty', data: bytes })
    expect(encoded).toEqual({ kind: 'pty', data: Buffer.from(bytes).toString('base64') })
    const decoded = Schema.decodeUnknownSync(SessionStream)(encoded)
    expect(decoded.kind === 'pty' && Array.from(decoded.data)).toEqual(Array.from(bytes))
  })
  it('carries an event untouched', () => {
    const frame = { kind: 'event', event: { type: 'state_change', state: 'done' } }
    expect(
      Schema.encodeSync(SessionStream)(Schema.decodeUnknownSync(SessionStream)(frame))
    ).toEqual(frame)
  })
  it('a write is a typed input or bytes, nothing else', () => {
    expect(Either.isRight(decode(SessionWrite, { type: 'bytes', data: 'aGk=' }))).toBe(true)
    expect(Either.isRight(decode(SessionWrite, { type: 'interrupt' }))).toBe(true)
    expect(Either.isLeft(decode(SessionWrite, { type: 'bytes', data: '***' }))).toBe(true)
    expect(Either.isLeft(decode(SessionWrite, new Uint8Array([1])))).toBe(true)
  })
})
