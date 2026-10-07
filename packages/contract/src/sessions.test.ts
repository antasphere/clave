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
  GetSessionHistory,
  Session,
  SessionEvent,
  SessionInfo,
  SessionInput,
  SessionStream,
  SessionWrite,
  SpawnOptions
} from './sessions'
import { CapabilityUnavailable } from './errors'
import { ServerEvent } from './events'

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
  it('drops a prepared prompt from a wire write, which only the host may build', () => {
    const message = { type: 'user_message', text: 'hi' }
    expect(decode(SessionWrite, message)).toEqual(Either.right(message))
    const smuggled = { ...message, prepared: { text: 'injected', images: [] } }
    expect(decode(SessionWrite, smuggled)).toEqual(Either.right(message))
    // In-process, the host's own union still carries it.
    expect(decode(SessionInput, smuggled)).toEqual(Either.right(smuggled))
  })
})

describe('starting a session on the wire', () => {
  const full = {
    dangerousMode: true,
    model: 'opus',
    claudeMode: true,
    antigravityMode: false,
    codexMode: false,
    piMode: false,
    claudeAgentsMode: false,
    resumeSessionId: 'r1',
    claudeSessionId: 'c1',
    piSessionId: 'p1',
    launchProfileId: 'lp1',
    piProvider: 'anthropic',
    piThinking: 'high',
    initialCommand: 'ls',
    autoExecute: true,
    initialPrompt: 'hello',
    tmuxMode: true,
    adoptTmuxName: 'clave-1',
    adoptSessionId: 'a1',
    configDir: '/cfg',
    claudeProfileId: 'cp1',
    claudeProfileLabel: 'Work',
    codexAccountId: 'ca1',
    codexAccountLabel: 'Personal',
    workspaceId: 'ws1'
  }
  const links = [
    { kind: 'group-terminal', groupId: 'g1', terminalId: 't1' },
    { kind: 'session-view', ownerId: 'o1' },
    { kind: 'toolbar', key: 'k1' }
  ]

  it('takes spawn options with no field at all', () => {
    expect(decode(SpawnOptions, {})).toEqual(Either.right({}))
  })
  it.each(links.map((link) => [link.kind, link]))(
    'takes the full option set with a link of kind %s',
    (_, link) => {
      const options = { ...full, link }
      expect(decode(SpawnOptions, options)).toEqual(Either.right(options))
    }
  )
  it('refuses a link of a kind it does not know', () => {
    expect(Either.isLeft(decode(SpawnOptions, { link: { kind: 'sidebar', key: 'k' } }))).toBe(true)
  })
  it('round-trips the started session’s record, with and without its optional fields', () => {
    const bare = {
      id: 'started-1',
      cwd: '/work/app',
      folderName: 'app',
      alive: true,
      claudeSessionId: null,
      piSessionId: null
    }
    const rich = {
      ...bare,
      claudeSessionId: 'c1',
      piSessionId: 'p1',
      launchProfileId: 'lp1',
      model: 'opus',
      piProvider: 'anthropic',
      piThinking: 'high'
    }
    for (const info of [bare, rich]) {
      const decoded = Schema.decodeUnknownSync(SessionInfo)(info)
      expect(decoded).toEqual(info)
      expect(Schema.encodeSync(SessionInfo)(decoded)).toEqual(info)
    }
    expect(Either.isLeft(decode(SessionInfo, { ...bare, id: '' }))).toBe(true)
  })
  it('decodes a history page’s numbers from the strings a GET carries', () => {
    const payload = Schema.decodeUnknownEither(GetSessionHistory.payload)
    expect(payload({ id: 'x', before: '12', limit: '40' })).toEqual(
      Either.right({ id: 'x', before: 12, limit: 40 })
    )
    expect(payload({ id: 'x' })).toEqual(Either.right({ id: 'x' }))
    expect(Either.isLeft(payload({ id: 'x', before: '-1' }))).toBe(true)
    expect(Either.isLeft(payload({ id: 'x', limit: '1.5' }))).toBe(true)
    expect(Either.isLeft(payload({ id: 'x', limit: 'many' }))).toBe(true)
  })
  it('encodes a missing capability with its tag, its capability and its message', () => {
    const error = new CapabilityUnavailable({ capability: 'sessions', message: 'no sessions here' })
    expect(Schema.encodeSync(CapabilityUnavailable)(error)).toEqual({
      _tag: 'CapabilityUnavailable',
      capability: 'sessions',
      message: 'no sessions here'
    })
  })
})

describe('the sessions’ server events', () => {
  const events: unknown[] = [
    { _tag: 'session.title_changed', id: 's1', title: 'Fix the build' },
    { _tag: 'session.plan_detected', id: 's1', path: '/plans/plan.md' },
    { _tag: 'session.cleared', id: 's1', providerSessionId: null },
    { _tag: 'session.cleared', id: 's1', providerSessionId: 'c2' }
  ]
  it.each(events.map((event) => [JSON.stringify(event), event]))('decodes %s', (_, event) => {
    expect(decode(ServerEvent, event)).toEqual(Either.right(event))
  })
  it('refuses a cleared session without its provider session id', () => {
    expect(Either.isLeft(decode(ServerEvent, { _tag: 'session.cleared', id: 's1' }))).toBe(true)
  })
})
