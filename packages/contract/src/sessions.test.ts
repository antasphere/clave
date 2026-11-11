import { describe, expect, it } from 'vitest'
import { Either, Schema } from 'effect'
import { z } from 'zod'
import {
  SessionControlSchema as ZodSessionControl,
  SessionSchema as ZodSession,
  SessionEventSchema as ZodSessionEvent,
  SessionInputSchema as ZodSessionInput,
  flattenAnswers
} from '../../../src/shared/session-model'
import {
  Attachments,
  RestartSession,
  RestartRequestId,
  GetSessionHistory,
  Session,
  SessionControl,
  SessionEvent,
  SessionInfo,
  SessionRecord,
  SessionInput,
  SessionStream,
  SessionWrite,
  SpawnOptions
} from './sessions'
import { CapabilityUnavailable } from './errors'
import { ServerEvent } from './events'

/** A whole valid work assignment (PRDCT-4123), as a record keeps it. */
const work = {
  unit: 'stable-wave/lane-a',
  kind: 'lane',
  label: 'Stable wave lanes',
  wave: 'stable-wave',
  waveLabel: 'Stable waves',
  role: 'lead',
  task: 'the plumbing',
  standing: 'current',
  joinedAt: 1,
  since: 2,
  from: '6f1c2c8e-1b9a-4d6e-9b1a-2f3c4d5e6f70'
}

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
  { type: 'permission_draft', id: 'clave:f', answers: { login: 'luca-b', projects: ['reb'] } },
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
  {
    type: 'user_message',
    text: 'list [Folder #1]',
    attachments: [
      {
        id: 'f',
        label: 'Folder #1',
        path: '/work/src',
        name: 'src',
        mimeType: 'inode/directory',
        size: 0,
        entries: 12,
        delivery: 'folder'
      }
    ]
  },
  {
    type: 'user_message',
    text: 'finish when [Session #1] is done',
    attachments: [
      {
        id: 'b',
        label: 'Session #1',
        delivery: 'session',
        sessionId: 'sess-1',
        name: 'Lane A',
        agent: 'Claude Code',
        cwd: '/work/a'
      }
    ]
  },
  { type: 'permission_response', id: 'p1', optionId: 'allow-once' },
  { type: 'permission_response', id: 'p1', optionId: 'answer', answers: { q: 'yes' } },
  { type: 'user_message', text: '[The form "Four things" was approved]', form: 'clave:1' },
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
  { type: 'permission_draft', id: 'clave:f', answers: { login: 7 } },
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
  { type: 'permission_withdrawn', id: 'p' },
  { type: 'permission_updated', id: 'p', answers: { login: 'luca-a', projects: ['reb'] } },
  { type: 'permission_updated', id: 'p', answers: { login: 'luca-a' }, sent: true },
  { type: 'permission_updated', id: 'p', answers: { login: 'luca-b' }, typed: true },
  { type: 'permission_explained', id: 'p', level: 'reads' },
  { type: 'permission_explained', id: 'p', sentence: 'Runs the tests.', asked: 'yes' },
  {
    type: 'permission_explained',
    id: 'p',
    level: 'irreversible',
    sentence: 'Deletes the build folder.',
    asked: 'no'
  },
  { type: 'permission_explained', id: 'p', level: 'outside', failed: 'timeout' },
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
  it.each(
    [
      { type: 'mcp_status' },
      { type: 'mcp_toggle', server: 'github', enabled: false },
      { type: 'mcp_reconnect', server: 'github' },
      { type: 'mcp_authenticate', server: 'github' },
      { type: 'mcp_clear_auth', server: 'github' },
      { type: 'reload_plugins' }
    ].map((request) => [JSON.stringify(request), request])
  )('accepts control request %s', (_, request) => {
    expect(ZodSessionControl.safeParse(request).success).toBe(true)
    expect(decode(SessionControl, request)).toEqual(Either.right(request))
  })
  it.each(
    [
      { type: 'set_permission_mode', mode: 'x' },
      { type: 'mcp_reconnect', server: '' },
      { type: 'mcp_toggle', server: '', enabled: true },
      { type: 'mcp_toggle', server: 'github' }
    ].map((request) => [JSON.stringify(request), request])
  )('refuses control request %s on both sides', (_, request) => {
    expect(ZodSessionControl.safeParse(request).success).toBe(false)
    expect(Either.isLeft(decode(SessionControl, request))).toBe(true)
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
  it('preserves stable question IDs and identical display text through both event schemas', () => {
    const event = {
      type: 'permission_request',
      id: 'native',
      description: 'Two questions',
      options: [{ id: 'answer', label: 'Submit' }],
      questions: [
        { id: 'first-id', question: 'Value?', header: 'Public', options: [] },
        { id: 'second-id', question: 'Value?', header: 'Private', options: [] }
      ]
    }
    expect(ZodSessionEvent.parse(event)).toEqual(event)
    expect(Schema.decodeUnknownSync(SessionEvent)(event)).toEqual(event)
    expect(
      Schema.encodeSync(SessionStream)(
        Schema.decodeUnknownSync(SessionStream)({ kind: 'event', event })
      )
    ).toEqual({ kind: 'event', event })
  })
  it('carries a hosted input request and its typed answers through both schemas (PRDCT-4157)', () => {
    const event = {
      type: 'permission_request',
      id: 'clave:7c1e',
      description: 'Before we set up your machine.',
      toolName: 'clave_request_input',
      input: { tool: 'clave_request_input', layout: 'form' },
      options: [
        { id: 'answer', label: 'Send' },
        { id: 'deny', label: 'Skip' }
      ],
      questions: [
        {
          id: 'email',
          question: 'Your team e-mail',
          kind: 'email',
          hint: 'The one on the hub',
          placeholder: 'you@antasphere.com',
          optional: false,
          options: []
        },
        {
          id: 'projects',
          question: 'Projects you join',
          kind: 'choice',
          multiSelect: true,
          optional: true,
          options: [{ label: 'reb' }, { label: 'wat' }]
        },
        {
          id: 'sign',
          question: 'Sign in',
          kind: 'link',
          url: 'https://github.com/login',
          confirm: "I'm signed in",
          options: []
        },
        { id: 'seats', question: 'Seats', kind: 'number', min: 1, max: 10, options: [] }
      ]
    }
    expect(ZodSessionEvent.parse(event)).toEqual(event)
    expect(Schema.decodeUnknownSync(SessionEvent)(event)).toEqual(event)
    const reply = {
      type: 'permission_response',
      id: 'clave:7c1e',
      optionId: 'answer',
      answers: { email: 'luca@antasphere.com', projects: ['reb', 'wat'], sign: 'done', seats: '3' }
    }
    expect(ZodSessionInput.parse(reply)).toEqual(reply)
    expect(Schema.decodeUnknownSync(SessionInput)(reply)).toEqual(reply)
    expect(() =>
      ZodSessionEvent.parse({ ...event, questions: [{ ...event.questions[0], kind: 'secret' }] })
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(SessionEvent)({
        ...event,
        questions: [{ ...event.questions[0], kind: 'secret' }]
      })
    ).toThrow()
  })
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
    // The person's typing into a form rides the wire to a server's session
    // (PRDCT-4210): the server's write route decodes it.
    expect(
      decode(SessionWrite, { type: 'permission_draft', id: 'clave:f', answers: { name: 'x' } })
    ).toEqual(Either.right({ type: 'permission_draft', id: 'clave:f', answers: { name: 'x' } }))
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
    launchProfile: {
      id: 'lp1',
      name: 'Mac profile',
      family: 'pi',
      command: ['pi-wrapper', 'pi'],
      additionalArgs: ['--color'],
      sourceProfileId: 'lp1',
      pi: { provider: 'anthropic', model: 'sonnet', thinking: 'high' }
    },
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
  it('refuses a carried launch profile with an unknown family', () => {
    expect(
      Either.isLeft(
        decode(SpawnOptions, { launchProfile: { ...full.launchProfile, family: 'other' } })
      )
    ).toBe(true)
  })
  it('round-trips a stopped record with and without a carried launch profile, and with its work', () => {
    const bare = {
      id: 'stopped-1',
      cwd: '/work/app',
      folderName: 'app',
      claudeMode: false,
      antigravityMode: false,
      codexMode: false,
      piMode: true,
      claudeAgentsMode: false,
      dangerousMode: false
    }
    for (const record of [
      bare,
      { ...bare, launchProfile: full.launchProfile },
      { ...bare, work }
    ]) {
      expect(decode(SessionRecord, record)).toEqual(Either.right(record))
      const decoded = Schema.decodeUnknownSync(SessionRecord)(record)
      expect(Schema.encodeSync(SessionRecord)(decoded)).toEqual(record)
    }
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
    { _tag: 'session.cleared', id: 's1', providerSessionId: 'c2' },
    { _tag: 'session.work_changed', id: 's1', work },
    { _tag: 'session.work_changed', id: 's1', work: null }
  ]
  it.each(events.map((event) => [JSON.stringify(event), event]))('decodes %s', (_, event) => {
    expect(decode(ServerEvent, event)).toEqual(Either.right(event))
  })
  it('refuses a cleared session without its provider session id', () => {
    expect(Either.isLeft(decode(ServerEvent, { _tag: 'session.cleared', id: 's1' }))).toBe(true)
  })
  it('carries a session’s model change with the model named (PRDCT-4256)', () => {
    const event = { _tag: 'session.model_changed', id: 's1', model: 'claude-opus-5-5' }
    expect(Schema.decodeUnknownSync(ServerEvent)(event)).toEqual(event)
    expect(Either.isLeft(decode(ServerEvent, { _tag: 'session.model_changed', id: 's1' }))).toBe(
      true
    )
    expect(
      Either.isLeft(decode(ServerEvent, { _tag: 'session.model_changed', id: 's1', model: null }))
    ).toBe(true)
  })
  it('carries a session’s limit report closing with its id alone (PRDCT-4415)', () => {
    const event = { _tag: 'session.limit_cleared', id: 's1' }
    expect(Schema.decodeUnknownSync(ServerEvent)(event)).toEqual(event)
    expect(Either.isLeft(decode(ServerEvent, { _tag: 'session.limit_cleared' }))).toBe(true)
  })
})

describe('restart correlation contract', () => {
  it('accepts legacy and correlated requests, and bounds correlation identifiers', () => {
    const payload = { id: 's1', account: {} }
    expect(Schema.decodeUnknownSync(RestartSession.payload)(payload)).toEqual(payload)
    expect(
      Schema.decodeUnknownSync(RestartSession.payload)({ ...payload, requestId: 'request-123' })
    ).toEqual({ ...payload, requestId: 'request-123' })
    for (const invalid of ['', 'x'.repeat(129), 'with whitespace', '../path'])
      expect(Either.isLeft(Schema.decodeUnknownEither(RestartRequestId)(invalid))).toBe(true)
    for (const requestId of [undefined, 'request-123']) {
      const event = {
        _tag: 'session.restarted',
        id: 's1',
        resumed: true,
        account: {},
        ...(requestId && { requestId })
      }
      expect(Schema.decodeUnknownSync(ServerEvent)(event)).toEqual(event)
    }
  })

  it("flattens a hosted multi-select for a provider's wire, one string per question", () => {
    expect(flattenAnswers({ a: 'x', b: ['y', 'z'], c: [] })).toEqual({ a: 'x', b: 'y, z', c: '' })
    expect(flattenAnswers(undefined)).toBeUndefined()
  })
})

describe("a set_model's remember flag crosses both decoders (PRDCT-4302)", () => {
  const input = { type: 'set_model', model: 'claude-opus-5-5', remember: false }
  it('the Effect schema keeps remember: false, and an absent flag stays absent', () => {
    const decode = Schema.decodeUnknownSync(SessionInput)
    expect(decode(input)).toEqual(input)
    expect('remember' in decode({ type: 'set_model', model: null })).toBe(false)
  })
  it('the zod schema keeps remember: false too', () => {
    expect(ZodSessionInput.parse(input)).toEqual(input)
    expect('remember' in ZodSessionInput.parse({ type: 'set_model', model: null })).toBe(false)
  })
})
