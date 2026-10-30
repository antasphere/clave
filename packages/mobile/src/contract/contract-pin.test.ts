/**
 * The pin that holds the phone's mirror to `@clave/contract`: the same
 * samples decode through the contract's own Effect schemas (loaded here,
 * under Node, where the framework's TypeScript runs) and through the
 * mirror's decoders, to equal values; the inputs the phone sends decode
 * through the contract's command payloads; and, at the type level, each
 * mirrored shape is assignable to the contract's and back. A field added,
 * renamed or retyped on one side fails here.
 */
import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import * as Sessions from '@clave/contract/sessions'
import * as Timeline from '@clave/contract/timeline'
import * as Requests from '@clave/contract/requests'
import * as Settings from '@clave/contract/settings'
import * as Files from '@clave/contract/files'
import * as Push from '@clave/contract/push'
import * as Events from '@clave/contract/events'
import { CapabilityUnavailable } from '@clave/contract/errors'
import {
  decodeFileText,
  decodeHistoryPage,
  decodeTimelinePage,
  decodeSessionPosition,
  decodeSessionStream,
  decodeLaunchProfiles,
  decodePendingRequest,
  decodeRequestSnapshot,
  decodeServerEventEnvelope,
  decodeServerFailure,
  decodeServerFrame,
  decodeSession,
  decodeSessionEvent,
  decodeSessionInfo,
  decodeSessionRecord,
  decodeWorkspaceState
} from './decode'
import type * as M from './types'

const session = {
  id: 's1',
  provider: 'claude',
  transport: 'events',
  cwd: '/tmp/scratch',
  windowKey: 'server',
  state: 'working',
  createdAt: 1_730_000_000_000,
  adapterId: 'claude-chat',
  title: 'A chat',
  viewId: 'clave.chat/chat'
}

const events: unknown[] = [
  { type: 'user_message', text: 'hello' },
  {
    type: 'user_message',
    text: 'see [Image #1]',
    attachments: [
      {
        id: 'a1',
        label: 'Image #1',
        path: '/tmp/a.png',
        name: 'a.png',
        mimeType: 'image/png',
        size: 12,
        delivery: 'image'
      },
      { id: 'a2', delivery: 'session', sessionId: 's2', name: 'Other', agent: 'claude', cwd: '/x' }
    ]
  },
  { type: 'assistant_text', delta: 'hel', final: false },
  { type: 'tool_call', id: 't1', name: 'Read', input: { path: '/x' }, parent: 'p' },
  { type: 'tool_result', id: 't1', output: 'ok', error: false },
  {
    type: 'permission_request',
    id: 'r1',
    description: 'Run it?',
    options: [
      { id: 'allow-once', label: 'Allow' },
      { id: 'deny', label: 'Deny' }
    ],
    toolName: 'Bash',
    input: { command: 'ls' },
    detail: 'ls',
    questions: [
      {
        id: 'q1',
        question: 'Which?',
        header: 'Pick',
        options: [{ label: 'A', description: 'a' }, { label: 'B' }],
        multiSelect: true
      }
    ]
  },
  { type: 'state_change', state: 'blocked' },
  { type: 'session_meta', model: 'claude-opus-5-5', providerSessionId: null },
  { type: 'effort', effort: 'high' },
  { type: 'error', message: 'boom', fatal: true },
  { type: 'turn_interrupted' },
  { type: 'context_usage', used: 10, window: 200, parent: 'p' },
  { type: 'subagent_model', parent: 'p', model: 'm' },
  { type: 'permission_mode', mode: 'default', modes: [{ id: 'default', label: 'Default' }] },
  {
    type: 'background_tasks',
    tasks: [{ id: 'b1', kind: 'shell', description: 'd', startedAt: 1, outputFile: '/o' }]
  },
  { type: 'provider_event', provider: 'codex', payload: { any: 1 } }
]

const request = {
  id: 'req-1',
  sessionId: 's1',
  kind: 'clarification',
  description: 'A question',
  createdAt: 1,
  providerRequestId: 'native-1',
  options: [{ id: 'answer', label: 'Answer' }],
  questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }], multiSelect: false }],
  secretQuestions: ['q'],
  toolName: 'AskUserQuestion',
  detail: 'd',
  input: { x: 1 },
  action: { type: 'env-file', file: '/tmp/.env', key: 'KEY' }
}

const launchProfiles = {
  version: 1,
  customProfiles: [
    {
      id: 'claude-chat',
      name: 'Claude (chat)',
      family: 'claude',
      command: ['claude'],
      additionalArgs: [],
      builtIn: true,
      sourceProfileId: 'claude'
    },
    {
      id: 'pi-x',
      name: 'Pi',
      family: 'pi',
      command: ['pi'],
      additionalArgs: ['--x'],
      pi: { provider: 'openai', model: 'gpt', thinking: 'high' }
    }
  ],
  globalDefaults: { claude: 'claude-chat' },
  workspaceOverrides: { ws1: { codex: 'codex-chat' } }
}

const workspaces = {
  version: 1,
  workspaces: [
    { id: 'ws1', name: 'scratch', rootDir: '/tmp/scratch', profileFile: null, createdAt: 1 }
  ],
  lastActiveWorkspaceId: 'ws1',
  activeWorkspaceId: null,
  pins: [{ anything: true }],
  pinsMigrated: true,
  revision: 3,
  instance: 'i-1'
}

const info = {
  id: 's9',
  cwd: '/tmp/scratch',
  folderName: 'scratch',
  alive: true,
  claudeSessionId: null,
  piSessionId: null,
  launchProfileId: 'claude-chat',
  model: 'm'
}

const record = {
  id: 's1',
  cwd: '/tmp/scratch',
  folderName: 'scratch',
  claudeMode: true,
  antigravityMode: false,
  codexMode: false,
  piMode: false,
  claudeAgentsMode: false,
  dangerousMode: false,
  workspaceId: 'ws1',
  displayName: 'A chat',
  launchProfileId: 'claude-chat',
  live: true,
  running: true
}

const envelope = {
  id: 'e1',
  seq: 4,
  at: 2,
  event: { _tag: 'session.state_changed', id: 's1', state: 'done' }
}

describe('the mirror decodes what the contract decodes', () => {
  it('Session', () => {
    expect(decodeSession(session)).toEqual(Schema.decodeUnknownSync(Sessions.Session)(session))
  })
  it('every SessionEvent member', () => {
    for (const event of events)
      expect(decodeSessionEvent(event)).toEqual(
        Schema.decodeUnknownSync(Sessions.SessionEvent)(event)
      )
  })
  it('HistoryPage', () => {
    const page = { items: events.map((event, i) => ({ event, at: i })), before: 12 }
    expect(decodeHistoryPage(page)).toEqual(Schema.decodeUnknownSync(Sessions.HistoryPage)(page))
    const last = { items: [], before: null }
    expect(decodeHistoryPage(last)).toEqual(Schema.decodeUnknownSync(Sessions.HistoryPage)(last))
  })
  it('SessionInfo', () => {
    expect(decodeSessionInfo(info)).toEqual(Schema.decodeUnknownSync(Sessions.SessionInfo)(info))
  })
  it('SessionRecord, the fields the phone reads', () => {
    const full = Schema.decodeUnknownSync(Sessions.SessionRecord)(record)
    const mirrored = decodeSessionRecord(record)
    for (const key of Object.keys(mirrored) as (keyof typeof mirrored)[])
      expect(mirrored[key]).toEqual(full[key])
  })
  it('PendingRequest and RequestSnapshot', () => {
    expect(decodePendingRequest(request)).toEqual(
      Schema.decodeUnknownSync(Requests.PendingRequest)(request)
    )
    const snapshot = { revision: 2, pending: [request] }
    expect(decodeRequestSnapshot(snapshot)).toEqual(
      Schema.decodeUnknownSync(Requests.RequestSnapshot)(snapshot)
    )
  })
  it('LaunchProfilePreferencesView', () => {
    expect(decodeLaunchProfiles(launchProfiles)).toEqual(
      Schema.decodeUnknownSync(Settings.LaunchProfilePreferencesView)(launchProfiles)
    )
  })
  it('WorkspaceStateView', () => {
    expect(decodeWorkspaceState(workspaces)).toEqual(
      Schema.decodeUnknownSync(Settings.WorkspaceStateView)(workspaces)
    )
  })
  it('FileText', () => {
    const file = { content: '# hi', truncated: false, size: 4, binary: false }
    expect(decodeFileText(file)).toEqual(Schema.decodeUnknownSync(Files.FileText)(file))
  })
  it('the server event envelope and the events the phone reads', () => {
    expect(decodeServerEventEnvelope(envelope)).toEqual(
      Schema.decodeUnknownSync(Events.ServerEventEnvelope)(envelope)
    )
    const changed = { _tag: 'requests.changed', revision: 7 }
    expect(decodeServerEventEnvelope({ ...envelope, event: changed })).toEqual(
      Schema.decodeUnknownSync(Events.ServerEventEnvelope)({ ...envelope, event: changed })
    )
    const ws = {
      _tag: 'workspaces.state_changed',
      workspaces: workspaces.workspaces,
      pins: [],
      origin: null,
      revision: 1,
      instance: 'i'
    }
    const contractSide = Schema.decodeUnknownSync(Events.ServerEventEnvelope)({
      ...envelope,
      event: ws
    })
    const mirrorSide = decodeServerEventEnvelope({ ...envelope, event: ws })
    expect(mirrorSide.event).toMatchObject({
      _tag: 'workspaces.state_changed',
      workspaces:
        contractSide.event._tag === 'workspaces.state_changed' ? contractSide.event.workspaces : []
    })
  })
  it('every ServerFrame the phone reads', () => {
    const frames: unknown[] = [
      { _tag: 'welcome', serverId: 'srv', protocol: 1, version: '2.4.0' },
      { _tag: 'welcome', serverId: 'srv', protocol: 1 },
      { _tag: 'subscribed', sessionId: 's1', session },
      { _tag: 'unsubscribed', sessionId: 's1' },
      { _tag: 'stream', sessionId: 's1', stream: { kind: 'event', event: events[2] } },
      { _tag: 'stream', sessionId: 's1', stream: { kind: 'pty', data: 'aGk=' } },
      { _tag: 'exit', sessionId: 's1', code: 0 },
      { _tag: 'event', ...envelope },
      { _tag: 'error', sessionId: 's1', message: 'Unknown session' },
      { _tag: 'error', message: 'Malformed frame' },
      { _tag: 'pong' }
    ]
    for (const frame of frames) {
      const contractSide = Schema.decodeUnknownSync(Push.ServerFrame)(frame)
      const mirrorSide = decodeServerFrame(frame)
      if (contractSide._tag === 'stream' && contractSide.stream.kind === 'pty') {
        // The contract decodes terminal bytes; the phone keeps the base64.
        expect(mirrorSide).toEqual({ ...(frame as object), stream: { kind: 'pty', data: 'aGk=' } })
        expect(contractSide.stream.data).toEqual(new TextEncoder().encode('hi'))
      } else expect(mirrorSide).toEqual(contractSide)
    }
  })
  it('a frame the contract will add later is carried by tag and ignored', () => {
    expect(decodeServerFrame({ _tag: 'request', requestId: 'r', windowKey: 'w' })._tag).toBe(
      'request'
    )
    expect(decodeServerFrame({ _tag: 'something-new' })._tag).toBe('request')
  })
  it('a declared failure as a 422 carries it', () => {
    const failure = new Sessions.SessionStartFailed({ message: 'Program "claude" was not found' })
    const encoded = Schema.encodeSync(Sessions.SessionStartFailed)(failure)
    expect(decodeServerFailure(encoded)).toEqual({
      _tag: 'SessionStartFailed',
      message: 'Program "claude" was not found'
    })
    const capability = Schema.encodeSync(CapabilityUnavailable)(
      new CapabilityUnavailable({
        capability: 'requests',
        message: 'This server holds no requests.'
      })
    )
    expect(decodeServerFailure(capability)).toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'requests'
    })
  })
})

describe('what the phone sends decodes through the contract', () => {
  it('a start with the family boolean, the profile id and its full definition', () => {
    const payload: M.StartSessionInput = {
      cwd: '/tmp/scratch',
      options: {
        claudeMode: true,
        launchProfileId: 'claude-chat',
        launchProfile: launchProfiles.customProfiles[0] as M.LaunchProfileView,
        workspaceId: 'ws1'
      }
    }
    expect(Schema.decodeUnknownSync(Sessions.StartSession.payload)(payload)).toEqual(payload)
  })
  it('a message keeps the id the phone minted through the server write contract', () => {
    const input: M.SessionWriteInput = {
      type: 'user_message',
      text: 'hi',
      clientMessageId: 'm-0123456789abcdef'
    }
    const decoded = Schema.decodeUnknownSync(Sessions.WriteSession.payload)({ id: 's1', input })
    expect(decoded).toEqual({ id: 's1', input })
  })
  it('a permission response through the write route', () => {
    const input: M.SessionWriteInput = {
      type: 'permission_response',
      id: 'r1',
      optionId: 'answer',
      answers: { q1: 'A, B' }
    }
    expect(Schema.decodeUnknownSync(Sessions.WriteSession.payload)({ id: 's1', input })).toEqual({
      id: 's1',
      input
    })
  })
  it('every RequestResponse the forms shape', () => {
    const responses: M.RequestResponse[] = [
      { type: 'permission', optionId: 'allow-once' },
      { type: 'permission', optionId: 'answer', answers: { q: 'A' } },
      { type: 'clarification', answers: { q: 'A' } },
      { type: 'secret', value: 'shh' },
      { type: 'dismiss' }
    ]
    for (const response of responses)
      expect(
        Schema.decodeUnknownSync(Requests.ResolvePendingRequest.payload)({
          requestId: 'req-1',
          response
        })
      ).toEqual({ requestId: 'req-1', response })
  })
  it('the client frames', () => {
    const frames: M.ClientFrame[] = [
      { _tag: 'hello', token: 't', client: 'clave-mobile/ios' },
      { _tag: 'subscribe', sessionId: 's1' },
      { _tag: 'unsubscribe', sessionId: 's1' },
      { _tag: 'ping' }
    ]
    for (const frame of frames)
      expect(Schema.decodeUnknownSync(Push.ClientFrame)(frame)).toEqual(frame)
  })
  it('the constants', () => {
    expect(Push.PUSH_PATH).toBe('/push')
    expect(Push.PUSH_PROTOCOL).toBe(1)
    expect(Push.CLOSE_UNAUTHORIZED).toBe(4001)
    expect(Push.CLOSE_MALFORMED).toBe(4002)
    expect(Push.CLOSE_HELLO_TIMEOUT).toBe(4008)
    expect(Push.CLOSE_SERVER_STOPPING).toBe(4010)
    expect(Push.HELLO_TIMEOUT_MS).toBe(5_000)
  })
})

describe('the mirror refuses what the contract refuses', () => {
  it('an unknown agent state, a missing field, a wrong type', () => {
    const bad: unknown[] = [
      { ...session, state: 'waiting' },
      { ...session, id: undefined },
      { ...session, createdAt: 'yesterday' }
    ]
    for (const sample of bad) {
      expect(() => Schema.decodeUnknownSync(Sessions.Session)(sample)).toThrow()
      expect(() => decodeSession(sample)).toThrow()
    }
    expect(() => decodeSessionEvent({ type: 'no_such_event' })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Sessions.SessionEvent)({ type: 'no_such_event' })
    ).toThrow()
  })
})

// ── The type-level pin: each mirrored shape assignable both ways ──
type Both<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const pins: {
  session: Both<M.Session, Sessions.Session>
  event: Both<M.SessionEvent, Sessions.SessionEvent>
  history: Both<M.HistoryPage, Sessions.HistoryPage>
  info: Both<M.SessionInfo, Sessions.SessionInfo>
  profile: Both<M.LaunchProfileView, typeof Settings.LaunchProfileView.Type>
  profiles: Both<M.LaunchProfilePreferencesView, typeof Settings.LaunchProfilePreferencesView.Type>
  workspace: Both<M.WorkspaceView, typeof Settings.WorkspaceView.Type>
  workspaces: Both<M.WorkspaceStateView, typeof Settings.WorkspaceStateView.Type>
  request: Both<M.PendingRequest, Requests.PendingRequest>
  response: Both<M.RequestResponse, Requests.RequestResponse>
  file: Both<M.FileText, Files.FileText>
  question: Both<M.AgentQuestion, Sessions.AgentQuestion>
  clientFrame: Both<M.ClientFrame, Push.ClientFrame>
} = {
  session: true,
  event: true,
  history: true,
  info: true,
  profile: true,
  profiles: true,
  workspace: true,
  workspaces: true,
  request: true,
  response: true,
  file: true,
  question: true,
  clientFrame: true
}
void pins

describe('ordered timeline mirror', () => {
  const cursor = { generation: 'adoption', sequence: 4 }
  it('pins positions, pages and push positions to the same contract samples', () => {
    const event = { type: 'user_message', text: 'a', clientMessageId: 'message-123' }
    const page = { items: [{ event, position: cursor, at: 1 }], before: 4, cursor, truncated: true }
    expect(decodeTimelinePage(page)).toEqual(Schema.decodeUnknownSync(Timeline.TimelinePage)(page))
    expect(decodeSessionPosition(cursor)).toEqual(
      Schema.decodeUnknownSync(Timeline.SessionPosition)(cursor)
    )
    for (const stream of [
      { kind: 'event', event, position: cursor },
      { kind: 'event', event }
    ])
      expect(decodeSessionStream(stream)).toEqual(
        Schema.decodeUnknownSync(Sessions.SessionStream)(stream)
      )
  })
  it('rejects empty generation, unsafe/negative/fractional sequence and missing page fields on both sides', () => {
    for (const position of [
      { generation: '', sequence: 1 },
      { generation: 'g', sequence: -1 },
      { generation: 'g', sequence: 0.5 },
      { generation: 'g', sequence: Number.MAX_SAFE_INTEGER + 1 }
    ]) {
      expect(() => decodeSessionPosition(position)).toThrow()
      expect(() => Schema.decodeUnknownSync(Timeline.SessionPosition)(position)).toThrow()
    }
    expect(() => decodeTimelinePage({ items: [], before: null, cursor })).toThrow()
  })
  it('rejects a page that mixes generations or reverses positions', () => {
    const event = { type: 'user_message', text: 'a' }
    for (const positions of [
      [{ ...cursor, generation: 'old' }],
      [cursor, { ...cursor, sequence: 3 }],
      [{ ...cursor, sequence: 5 }]
    ])
      expect(() =>
        decodeTimelinePage({
          items: positions.map((position) => ({ event, position })),
          before: null,
          cursor,
          truncated: false
        })
      ).toThrow()
  })
})

const timelinePin: Both<M.TimelinePage, Timeline.TimelinePage> = true
void timelinePin
