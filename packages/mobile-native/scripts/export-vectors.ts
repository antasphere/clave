/**
 * The fixture vectors both native phones test against (lane C of the native
 * mobile wave, PRDCT-4230): every wire shape a phone reads and every command
 * it sends, as JSON under packages/mobile-native/fixtures/, one file per
 * contract family, exported from the real contract and never written by
 * hand. The samples below are authored, but none reaches a file on its own
 * word: a valid sample is decoded through the contract's own Effect schema
 * and written back as the contract encodes it, so the wire form is the
 * server's and a sample the contract refuses stops the export; an invalid
 * sample is proven refused by the contract at export time. The literals
 * (the agent states, the pairing refusals, the notification categories),
 * the constants (the paths, the close codes, the bounds), the event tags
 * and the route table are read off the schemas, the modules, the event
 * union and the API's own groups, not restated; the device-session
 * allowlist is read off the server's scope module.
 *
 *   bun packages/mobile-native/scripts/export-vectors.ts          # writes the files
 *   bun packages/mobile-native/scripts/export-vectors.ts --check  # exits 1 on drift
 *
 * Bun, because the contract is TypeScript source whose framework imports
 * name `.js` files that are `.ts` on disk, which Node cannot resolve; the
 * server runs the same way from its sources. vectors.test.ts imports this
 * module under vitest, regenerates every file in memory and compares it
 * with the committed one, then decodes every committed sample once more.
 *
 * One block is the client's rule and not the contract's, and says so: the
 * ordering of a timeline page (docs/mobile-timeline.md). The contract
 * accepts a page that mixes generations; a phone must not.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Either, Schema, SchemaAST } from 'effect'
import { ClaveApi } from '@clave/contract/api'
import * as Devices from '@clave/contract/devices'
import { CONTRACT_VERSION } from '@clave/contract/env'
import { CapabilityUnavailable } from '@clave/contract/errors'
import * as Events from '@clave/contract/events'
import * as Files from '@clave/contract/files'
import * as Notify from '@clave/contract/notify'
import * as Push from '@clave/contract/push'
import * as Relay from '@clave/contract/relay'
import * as Requests from '@clave/contract/requests'
import * as Sessions from '@clave/contract/sessions'
import * as Settings from '@clave/contract/settings'
import * as Timeline from '@clave/contract/timeline'
import {
  DEVICE_FORBIDDEN_MESSAGE,
  deviceHearsEvent,
  deviceMayCall
} from '../../server/src/devices/scope'

export const FIXTURES_DIR = 'packages/mobile-native/fixtures'
export const GENERATOR = 'packages/mobile-native/scripts/export-vectors.ts'
export const INDEX_FILE = 'index.json'

type AnySchema = Schema.Schema.AnyNoContext
type Pairs = ReadonlyArray<readonly [name: string, sample: unknown]>
type Triples = ReadonlyArray<readonly [name: string, sample: unknown, because: string]>

export interface ValidSample {
  readonly name: string
  readonly wire: unknown
}
export interface RefusedSample extends ValidSample {
  readonly because: string
}
export interface ShapeVectors {
  readonly valid: ReadonlyArray<ValidSample>
  readonly invalid?: ReadonlyArray<RefusedSample>
}
export interface FailureVector {
  readonly tag: string
  readonly wire: unknown
}
export interface CommandVectors {
  readonly payload: ReadonlyArray<ValidSample>
  readonly invalidPayload?: ReadonlyArray<RefusedSample>
  readonly success?: ReadonlyArray<ValidSample>
  readonly failures?: ReadonlyArray<FailureVector>
}
interface CommandLike {
  readonly payload: AnySchema
  readonly success: AnySchema
}
interface TaggedErrorClass {
  new (fields: never): unknown
}

/** The decode of one sample, or the reason it was refused. */
function decode(schema: AnySchema, sample: unknown): Either.Either<unknown, string> {
  const result = Schema.decodeUnknownEither(schema)(sample)
  return Either.isRight(result) ? Either.right(result.right) : Either.left(result.left.message)
}

/** A sample the contract accepts, written back as the contract encodes it. */
function roundTrip(schema: AnySchema, sample: unknown, label: string): unknown {
  const decoded = decode(schema, sample)
  if (Either.isLeft(decoded))
    throw new Error(`export-vectors: ${label} is refused by the contract:\n${decoded.left}`)
  return Schema.encodeSync(schema)(decoded.right)
}

/** A sample the contract must refuse; the export stops when it does not. */
function refused(schema: AnySchema, sample: unknown, label: string): unknown {
  if (Either.isRight(decode(schema, sample)))
    throw new Error(`export-vectors: ${label} is accepted by the contract and cannot be invalid`)
  return sample
}

/** The members of a `Schema.Literal`. */
function literalsOf(schema: unknown, label: string): ReadonlyArray<string | number | boolean> {
  const literals = (schema as { literals?: ReadonlyArray<string | number | boolean> }).literals
  if (!literals) throw new Error(`export-vectors: ${label} is not a Schema.Literal`)
  return literals
}

/** The `_tag` of every member of a union of tagged structs, in order. */
function tagsOf(schema: AnySchema, label: string): ReadonlyArray<string> {
  const ast = schema.ast
  if (!SchemaAST.isUnion(ast)) throw new Error(`export-vectors: ${label} is not a union`)
  return ast.types.map((member) => {
    const literal = SchemaAST.isTypeLiteral(member)
      ? member.propertySignatures.find((p) => p.name === '_tag')?.type
      : undefined
    if (!literal || !SchemaAST.isLiteral(literal) || typeof literal.literal !== 'string')
      throw new Error(`export-vectors: a member of ${label} has no string _tag`)
    return literal.literal
  })
}

/** One family's file: its shapes and commands collected with their schemas,
 *  so the test can decode the committed samples once more. */
class Family {
  readonly schemas: Record<string, AnySchema> = {}
  constructor(readonly name: string) {}

  shape(name: string, schema: AnySchema, valid: Pairs, invalid: Triples = []): ShapeVectors {
    this.schemas[name] = schema
    const label = `${this.name}.${name}`
    return {
      valid: valid.map(([n, sample]) => ({
        name: n,
        wire: roundTrip(schema, sample, `${label}.${n}`)
      })),
      ...(invalid.length
        ? {
            invalid: invalid.map(([n, sample, because]) => ({
              name: n,
              wire: refused(schema, sample, `${label}.${n}`),
              because
            }))
          }
        : {})
    }
  }

  command(
    name: string,
    command: CommandLike,
    spec: {
      readonly payload: Pairs
      readonly invalidPayload?: Triples
      readonly success?: Pairs
      readonly failures?: ReadonlyArray<FailureVector>
    }
  ): CommandVectors {
    this.schemas[`${name}.payload`] = command.payload
    const label = `${this.name}.${name}`
    const out: {
      payload: ValidSample[]
      invalidPayload?: RefusedSample[]
      success?: ValidSample[]
      failures?: FailureVector[]
    } = {
      payload: spec.payload.map(([n, sample]) => ({
        name: n,
        wire: roundTrip(command.payload, sample, `${label}.payload.${n}`)
      }))
    }
    if (spec.invalidPayload?.length)
      out.invalidPayload = spec.invalidPayload.map(([n, sample, because]) => ({
        name: n,
        wire: refused(command.payload, sample, `${label}.payload.${n}`),
        because
      }))
    if (spec.success?.length) {
      this.schemas[`${name}.success`] = command.success
      out.success = spec.success.map(([n, sample]) => ({
        name: n,
        wire: roundTrip(command.success, sample, `${label}.success.${n}`)
      }))
    }
    if (spec.failures?.length) out.failures = [...spec.failures]
    return out
  }
}

/** A declared failure as a 422 carries it: the class encoded by its own schema. */
function failure<F extends TaggedErrorClass & AnySchema>(
  Failure: F,
  fields: ConstructorParameters<F>[0]
): FailureVector {
  const wire = Schema.encodeSync(Failure)(new Failure(fields)) as { _tag: string }
  return { tag: wire._tag, wire }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

// ── The samples ──────────────────────────────────────────────────────────

const NOW = 1_730_000_000_000
const session = {
  id: 's1',
  provider: 'claude',
  transport: 'events',
  cwd: '/tmp/scratch',
  windowKey: 'server',
  state: 'working',
  createdAt: NOW,
  adapterId: 'claude-chat',
  title: 'A chat'
}
const fullSession = {
  ...session,
  groupId: 'g1',
  workspaceId: 'ws1',
  viewId: 'clave.chat/chat'
}
const imageAttachment = {
  id: 'a1',
  label: 'Image #1',
  path: '/tmp/a.png',
  name: 'a.png',
  mimeType: 'image/png',
  size: 12,
  delivery: 'image'
}
const sessionAttachment = {
  id: 'a2',
  delivery: 'session',
  sessionId: 's2',
  name: 'Other',
  agent: 'claude',
  cwd: '/x'
}
const question = {
  id: 'q1',
  question: 'Which?',
  header: 'Pick',
  options: [{ label: 'A', description: 'a' }, { label: 'B' }],
  multiSelect: true
}
const events: Pairs = [
  ['user_message', { type: 'user_message', text: 'hello' }],
  [
    'user_message with attachments',
    {
      type: 'user_message',
      text: 'see [Image #1]',
      attachments: [imageAttachment, sessionAttachment]
    }
  ],
  [
    'user_message with a client message id',
    { type: 'user_message', text: 'hi', clientMessageId: 'm-0123456789abcdef' }
  ],
  [
    'user_message of a subagent',
    { type: 'user_message', text: 'subagent brief', parent: 'parent' }
  ],
  ['assistant_text delta', { type: 'assistant_text', delta: 'hel', final: false }],
  [
    'assistant_text final of a subagent',
    { type: 'assistant_text', delta: 'subagent answer', final: true, parent: 'parent' }
  ],
  ['tool_call', { type: 'tool_call', id: 't1', name: 'Read', input: { path: '/x' }, parent: 'p' }],
  ['tool_result', { type: 'tool_result', id: 't1', output: 'ok', error: false }],
  ['tool_result of a subagent', { type: 'tool_result', id: 'sub', output: 'ok', parent: 'parent' }],
  ['permission_withdrawn', { type: 'permission_withdrawn', id: 'retired' }],
  [
    'permission_request with questions',
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
      questions: [question]
    }
  ],
  ['state_change', { type: 'state_change', state: 'blocked' }],
  ['session_meta', { type: 'session_meta', model: 'claude-opus-5-5', providerSessionId: null }],
  ['effort', { type: 'effort', effort: 'high' }],
  ['error', { type: 'error', message: 'boom', fatal: true }],
  ['turn_interrupted', { type: 'turn_interrupted' }],
  ['context_usage', { type: 'context_usage', used: 10, window: 200, parent: 'p' }],
  ['subagent_model', { type: 'subagent_model', parent: 'p', model: 'm' }],
  [
    'permission_mode',
    { type: 'permission_mode', mode: 'default', modes: [{ id: 'default', label: 'Default' }] }
  ],
  [
    'background_tasks',
    {
      type: 'background_tasks',
      tasks: [
        {
          id: 'b1',
          kind: 'shell',
          description: 'd',
          command: 'echo example',
          startedAt: 1,
          outputFile: '/o'
        }
      ]
    }
  ],
  ['provider_event', { type: 'provider_event', provider: 'codex', payload: { any: 1 } }]
]
const eventOf = (name: string): unknown => {
  const found = events.find(([n]) => n === name)
  if (!found) throw new Error(`export-vectors: no event sample named ${name}`)
  return found[1]
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
const chatProfile = {
  id: 'claude-chat',
  name: 'Claude (chat)',
  family: 'claude',
  command: ['claude'],
  additionalArgs: [],
  builtIn: true,
  sourceProfileId: 'claude'
}
const piProfile = {
  id: 'pi-x',
  name: 'Pi',
  family: 'pi',
  command: ['pi'],
  additionalArgs: ['--x'],
  pi: { provider: 'openai', model: 'gpt', thinking: 'high' }
}
const launchProfiles = {
  version: 1,
  customProfiles: [chatProfile, piProfile],
  globalDefaults: { claude: 'claude-chat' },
  workspaceOverrides: { ws1: { codex: 'codex-chat' } }
}
const workspace = {
  id: 'ws1',
  name: 'scratch',
  rootDir: '/tmp/scratch',
  profileFile: null,
  createdAt: 1
}
const workspaces = {
  version: 1,
  workspaces: [workspace],
  lastActiveWorkspaceId: 'ws1',
  activeWorkspaceId: null,
  pins: [{ anything: true }],
  pinsMigrated: true,
  revision: 3,
  instance: 'i-1'
}
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
  input: { x: 1 }
}
const permissionRequest = {
  id: 'req-2',
  sessionId: 's1',
  kind: 'permission',
  description: 'Run `ls`?',
  createdAt: 2,
  options: [
    { id: 'allow-once', label: 'Allow' },
    { id: 'deny', label: 'Deny' }
  ],
  toolName: 'Bash',
  input: { command: 'ls' }
}
const secretRequest = {
  id: 'req-3',
  sessionId: 's1',
  kind: 'secret',
  description: 'The API key for the service',
  createdAt: 3,
  action: { type: 'env-file', file: '/tmp/.env', key: 'SERVICE_KEY' }
}
const secretRunRequest = {
  ...secretRequest,
  id: 'req-4',
  action: { type: 'run', command: 'service login --token', cwd: '/tmp/scratch', envVar: 'TOKEN' }
}
const envelope = { id: 'e1', seq: 4, at: 2 }
const cursor = { generation: 'adoption', sequence: 4 }
const timelineEvent = { type: 'user_message', text: 'a', clientMessageId: 'message-123' }
const snapshot = {
  items: [
    { event: timelineEvent, position: { generation: 'adoption', sequence: 3 }, at: 1 },
    { event: { type: 'assistant_text', delta: 'a', final: true }, position: cursor }
  ],
  before: 2,
  cursor,
  truncated: false
}
const timelinePage = (
  positions: ReadonlyArray<{ generation: string; sequence: number }>
): unknown => ({
  items: positions.map((position) => ({ event: { type: 'user_message', text: 'a' }, position })),
  before: null,
  cursor,
  truncated: false
})
const device = { name: 'Fixture iPhone', platform: 'ios', appVersion: '0.1.0' }
const androidDevice = { name: 'Fixture Pixel', platform: 'android', appVersion: '0.1.0' }
const deviceView = {
  id: 'dev-1',
  name: 'Fixture iPhone',
  platform: 'ios',
  appVersion: '0.1.0',
  createdAt: NOW,
  lastSeenAt: null
}
const pendingPairing = {
  id: 'pair-1',
  name: 'Fixture Pixel',
  platform: 'android',
  appVersion: '0.1.0',
  requestedAt: NOW,
  expiresAt: NOW + 600_000
}
const deviceSession = {
  token: '0123456789abcdef'.repeat(4),
  deviceId: 'dev-1',
  serverId: 'srv-1',
  serverName: 'Fixture Mac'
}
const machine = {
  id: 'm_0123456789abcdef',
  name: 'Fixture Mac · Fixture Owner',
  platform: 'macos',
  version: '2.4.0',
  online: true,
  lastSeen: NOW,
  direct: []
}
const notification = (
  category: string,
  text: string,
  actions: ReadonlyArray<string>,
  extra: Record<string, unknown> = {}
): unknown => ({
  category,
  serverId: 'srv-1',
  serverName: 'Fixture Mac',
  sessionId: 's1',
  sessionTitle: 'A chat',
  workspaceName: 'scratch',
  text,
  actions,
  ...extra
})

/** A timeline page as the phone must read it (docs/mobile-timeline.md):
 *  one generation per page, the cursor's; sequences strictly increasing;
 *  none above the cursor. The contract accepts a page that breaks this; a
 *  phone refuses it and takes a fresh snapshot. */
export function timelinePageOrdered(page: unknown): boolean {
  const p = page as {
    items: ReadonlyArray<{ position: { generation: string; sequence: number } }>
    cursor: { generation: string; sequence: number }
  }
  let last = -1
  for (const item of p.items) {
    if (item.position.generation !== p.cursor.generation) return false
    if (item.position.sequence <= last) return false
    if (item.position.sequence > p.cursor.sequence) return false
    last = item.position.sequence
  }
  return true
}

// ── The families ─────────────────────────────────────────────────────────

interface FamilyFile {
  readonly file: string
  readonly schemas: Record<string, AnySchema>
  readonly data: Record<string, unknown>
}

const header = (family: string, notes: ReadonlyArray<string>): Record<string, unknown> => ({
  $comment: `Generated from the real contract by ${GENERATOR}. Do not edit: run \`npm run vectors --workspace @clave/mobile-native\`; vectors.test.ts fails when this file no longer matches the contract.`,
  family,
  contract: CONTRACT_VERSION,
  notes
})

function sessionsFamily(): FamilyFile {
  const f = new Family('sessions')
  return {
    file: 'sessions.json',
    schemas: f.schemas,
    data: {
      ...header('sessions', [
        'The session record, what a session streams, the history page, and the commands a phone sends on /sessions/*; the ordered timeline is timeline.json.',
        'A failure travels as a 422 whose body is the encoded tagged error under `failures`; a 401 is the token refused and carries no body a client reads.',
        'The clientMessageId a phone mints is 8 to 64 characters of letters, digits, dot, underscore, colon and dash; a second write with the same id writes nothing and answers the first write.'
      ]),
      literals: {
        AgentState: literalsOf(Sessions.AgentState, 'AgentState'),
        Transport: literalsOf(Sessions.Transport, 'Transport'),
        WriteStatus: literalsOf(Sessions.WriteStatus, 'WriteStatus'),
        WriteAnswerStatus: literalsOf(Sessions.WriteAnswer.fields.status, 'WriteAnswer.status')
      },
      constants: { MAX_ATTACHMENTS: Sessions.MAX_ATTACHMENTS },
      shapes: {
        Session: f.shape(
          'Session',
          Sessions.Session,
          [
            ['minimal', session],
            ['with a group, a workspace stamp and a view', fullSession]
          ],
          [
            [
              'an unknown agent state',
              { ...session, state: 'waiting' },
              'state is not an agent state'
            ],
            ['a missing id', { ...session, id: undefined }, 'id is required'],
            ['an empty id', { ...session, id: '' }, 'id is a non-empty string'],
            [
              'a textual createdAt',
              { ...session, createdAt: 'yesterday' },
              'createdAt is a number'
            ],
            [
              'a numeric workspace stamp',
              { ...session, workspaceId: 7 },
              'workspaceId is a string'
            ],
            [
              'a null workspace stamp',
              { ...session, workspaceId: null },
              'workspaceId is absent or a string'
            ],
            ['an unknown transport', { ...session, transport: 'ws' }, 'transport is pty or events']
          ]
        ),
        SessionEvent: f.shape('SessionEvent', Sessions.SessionEvent, events, [
          ['an unknown event type', { type: 'no_such_event' }, 'type is one of the event types'],
          [
            'a state_change to an unknown state',
            { type: 'state_change', state: 'paused' },
            'state is an agent state'
          ],
          [
            'an assistant_text without final',
            { type: 'assistant_text', delta: 'x' },
            'final is required'
          ],
          [
            'a user_message with a short client message id',
            { type: 'user_message', text: 'hi', clientMessageId: 'm-1' },
            'clientMessageId is 8 to 64 characters'
          ],
          [
            'a user_message with eleven attachments',
            {
              type: 'user_message',
              text: 'x',
              attachments: Array.from({ length: 11 }, (_, i) => ({
                ...imageAttachment,
                id: `a${i}`
              }))
            },
            'at most 10 attachments'
          ],
          [
            'a tool_call without a name',
            { type: 'tool_call', id: 't1', input: {} },
            'name is required'
          ],
          [
            'a permission_request without options',
            { type: 'permission_request', id: 'r1', description: 'Run it?' },
            'options is required'
          ]
        ]),
        HistoryPage: f.shape(
          'HistoryPage',
          Sessions.HistoryPage,
          [
            [
              'a page with an older page before it',
              { items: events.slice(0, 3).map(([, event], at) => ({ event, at })), before: 12 }
            ],
            ['the last page', { items: [], before: null }]
          ],
          [
            ['a page without before', { items: [] }, 'before is a number or null'],
            ['items that are not a list', { items: 'x', before: null }, 'items is an array']
          ]
        ),
        SessionInfo: f.shape(
          'SessionInfo',
          Sessions.SessionInfo,
          [
            ['a started chat', info],
            [
              'a session that is not alive',
              {
                id: 's9',
                cwd: '/tmp/scratch',
                folderName: 'scratch',
                alive: false,
                claudeSessionId: null,
                piSessionId: null
              }
            ]
          ],
          [['a textual alive', { ...info, alive: 'yes' }, 'alive is a boolean']]
        ),
        SessionStream: f.shape(
          'SessionStream',
          Sessions.SessionStream,
          [
            [
              'an event with its position',
              { kind: 'event', event: timelineEvent, position: cursor }
            ],
            [
              'an event without a position',
              { kind: 'event', event: eventOf('assistant_text delta') }
            ],
            ['terminal bytes, base64 on the wire', { kind: 'pty', data: 'aGk=' }]
          ],
          [['terminal bytes that are not base64', { kind: 'pty', data: '***' }, 'data is base64']]
        ),
        SessionCapabilities: f.shape('SessionCapabilities', Sessions.SessionCapabilities, [
          ['images accepted', { images: true }],
          ['images refused', { images: false }]
        ]),
        WriteAnswer: f.shape(
          'WriteAnswer',
          Sessions.WriteAnswer,
          [
            ['accepted', { status: 'accepted', at: NOW }],
            ['pending', { status: 'pending' }]
          ],
          [['an unknown status', { status: 'done' }, 'status is accepted or pending']]
        ),
        WriteStatusView: f.shape(
          'WriteStatusView',
          Sessions.WriteStatusView,
          [
            ['accepted', { status: 'accepted', at: NOW }],
            ['pending', { status: 'pending' }],
            ['rejected', { status: 'rejected', reason: 'The provider refused the message.' }],
            ['absent', { status: 'absent' }],
            ['unknown', { status: 'unknown' }]
          ],
          [['an unknown status', { status: 'lost' }, 'status is one of the write statuses']]
        )
      },
      commands: {
        ListSessions: f.command('ListSessions', Sessions.ListSessions, {
          payload: [
            ['every session', {}],
            ['the sessions of one window', { windowKey: 'server' }]
          ],
          success: [['two sessions', [session, fullSession]]],
          failures: [
            failure(CapabilityUnavailable, {
              capability: 'sessions',
              message: 'This server runs no sessions.'
            })
          ]
        }),
        GetSession: f.command('GetSession', Sessions.GetSession, {
          payload: [['by id', { id: 's1' }]],
          success: [['the session', fullSession]],
          failures: [failure(Sessions.SessionNotFound, { id: 's1' })]
        }),
        StartSession: f.command('StartSession', Sessions.StartSession, {
          payload: [
            [
              'an Echo chat on the fixture server',
              {
                cwd: '/tmp/scratch',
                options: {
                  claudeMode: true,
                  launchProfileId: 'dev-echo-adapter',
                  workspaceId: 'ws1'
                }
              }
            ],
            [
              'a chat from a saved profile, its definition carried',
              {
                cwd: '/tmp/scratch',
                options: {
                  claudeMode: true,
                  launchProfileId: 'claude-chat',
                  launchProfile: chatProfile,
                  workspaceId: 'ws1'
                }
              }
            ],
            ['a bare start', { cwd: '/tmp/scratch' }]
          ],
          invalidPayload: [
            ['no cwd', { options: {} }, 'cwd is required'],
            [
              'a permission mode the contract does not know',
              { cwd: '/tmp/scratch', options: { permissionMode: 'yolo' } },
              'permissionMode is default, acceptEdits or plan'
            ]
          ],
          success: [['the started session', info]],
          failures: [
            failure(CapabilityUnavailable, {
              capability: 'terminals',
              message: 'This server runs no terminal process.'
            }),
            failure(Sessions.SessionStartFailed, { message: 'Program "claude" was not found' })
          ]
        }),
        StopSession: f.command('StopSession', Sessions.StopSession, {
          payload: [['by id', { id: 's1' }]],
          failures: [failure(Sessions.SessionStopFailed, { id: 's1', message: 'kill ESRCH' })]
        }),
        WriteSession: f.command('WriteSession', Sessions.WriteSession, {
          payload: [
            [
              'a message with the id the phone minted',
              {
                id: 's1',
                input: { type: 'user_message', text: 'hi', clientMessageId: 'm-0123456789abcdef' }
              }
            ],
            [
              'a message with prepared attachments',
              {
                id: 's1',
                input: {
                  type: 'user_message',
                  text: 'see [Image #1]',
                  attachments: [imageAttachment],
                  clientMessageId: 'm-0123456789abcdef'
                }
              }
            ],
            [
              'a permission response with answers',
              {
                id: 's1',
                input: {
                  type: 'permission_response',
                  id: 'r1',
                  optionId: 'answer',
                  answers: { q1: 'A, B' }
                }
              }
            ],
            ['an interrupt', { id: 's1', input: { type: 'interrupt' } }],
            ['a model change', { id: 's1', input: { type: 'set_model', model: 'echo-2' } }],
            ['an effort change', { id: 's1', input: { type: 'set_effort', effort: 'high' } }],
            [
              'a permission mode change',
              { id: 's1', input: { type: 'set_permission_mode', mode: 'default' } }
            ],
            ['a stopped background task', { id: 's1', input: { type: 'stop_task', taskId: 'b1' } }]
          ],
          invalidPayload: [
            [
              'a short client message id',
              { id: 's1', input: { type: 'user_message', text: 'hi', clientMessageId: 'short' } },
              'clientMessageId is 8 to 64 characters'
            ],
            [
              'an unknown input type',
              { id: 's1', input: { type: 'shout', text: 'HI' } },
              'type is one of the inputs'
            ],
            [
              'an effort with a capital',
              { id: 's1', input: { type: 'set_effort', effort: 'High' } },
              'effort is a short lowercase word'
            ]
          ],
          success: [
            ['accepted', { status: 'accepted', at: NOW }],
            ['pending', { status: 'pending' }]
          ],
          failures: [
            failure(Sessions.SessionNotFound, { id: 's1' }),
            failure(Sessions.SessionWriteRefused, {
              id: 's1',
              message: 'The provider refused the message.'
            }),
            failure(Sessions.SessionWriteUnknown, {
              id: 's1',
              clientMessageId: 'm-0123456789abcdef',
              message: 'The server cannot tell whether the message arrived.'
            })
          ]
        }),
        GetSessionCapabilities: f.command(
          'GetSessionCapabilities',
          Sessions.GetSessionCapabilities,
          {
            payload: [['by id', { id: 's1' }]],
            success: [['images accepted', { images: true }]],
            failures: [failure(Sessions.SessionNotFound, { id: 's1' })]
          }
        ),
        GetSessionHistory: f.command('GetSessionHistory', Sessions.GetSessionHistory, {
          payload: [
            ['the newest page', { id: 's1' }],
            [
              'an older page, the numbers as query strings',
              { id: 's1', before: '12', limit: '200' }
            ]
          ],
          invalidPayload: [
            ['a negative before', { id: 's1', before: '-1' }, 'before is a non-negative integer'],
            ['a limit that is not a number', { id: 's1', limit: 'x' }, 'limit is a number']
          ],
          success: [['the last page', { items: [], before: null }]],
          failures: [failure(Sessions.SessionNotFound, { id: 's1' })]
        }),
        GetSessionWriteStatus: f.command('GetSessionWriteStatus', Sessions.GetSessionWriteStatus, {
          payload: [
            [
              'by session and client message id',
              { id: 's1', clientMessageId: 'm-0123456789abcdef' }
            ]
          ],
          invalidPayload: [
            [
              'a short client message id',
              { id: 's1', clientMessageId: 'm-1' },
              'clientMessageId is 8 to 64 characters'
            ]
          ],
          success: [
            ['accepted', { status: 'accepted', at: NOW }],
            ['absent', { status: 'absent' }],
            ['unknown', { status: 'unknown' }]
          ]
        }),
        RestartSession: f.command('RestartSession', Sessions.RestartSession, {
          payload: [
            ['on the same account', { id: 's1', account: {} }],
            ['with a request id', { id: 's1', account: {}, requestId: 'restart-1' }]
          ],
          success: [
            [
              'the restarted session, its conversation resumed',
              { ...info, requestId: 'restart-1', resumed: true }
            ]
          ],
          failures: [
            failure(Sessions.SessionNotFound, { id: 's1' }),
            failure(Sessions.SessionStartFailed, {
              message: 'This host did not spawn the session.'
            })
          ]
        })
      }
    }
  }
}

function timelineFamily(): FamilyFile {
  const f = new Family('timeline')
  const mixed = timelinePage([{ generation: 'old', sequence: 3 }, cursor])
  const reversed = timelinePage([cursor, { generation: 'adoption', sequence: 3 }])
  const repeated = timelinePage([cursor, cursor])
  const aboveCursor = timelinePage([{ generation: 'adoption', sequence: 5 }])
  const ordering = {
    rule: 'docs/mobile-timeline.md: every item is in the cursor’s generation, sequences strictly increase, none is above the cursor; a page that breaks this is dropped and a fresh snapshot taken. The contract accepts these pages; the rule is the phone’s.',
    accepted: [
      {
        name: 'a snapshot with two items and its cursor',
        wire: roundTrip(Timeline.TimelinePage, snapshot, 'timeline.ordering.snapshot')
      },
      {
        name: 'the empty snapshot',
        wire: roundTrip(
          Timeline.TimelinePage,
          { items: [], before: null, cursor: { generation: 'g', sequence: 0 }, truncated: false },
          'timeline.ordering.empty'
        )
      }
    ],
    refused: [
      {
        name: 'a page mixing generations',
        wire: roundTrip(Timeline.TimelinePage, mixed, 'timeline.ordering.mixed')
      },
      {
        name: 'reversed positions',
        wire: roundTrip(Timeline.TimelinePage, reversed, 'timeline.ordering.reversed')
      },
      {
        name: 'a repeated position',
        wire: roundTrip(Timeline.TimelinePage, repeated, 'timeline.ordering.repeated')
      },
      {
        name: 'a position above the cursor',
        wire: roundTrip(Timeline.TimelinePage, aboveCursor, 'timeline.ordering.above')
      }
    ]
  }
  for (const sample of ordering.accepted)
    if (!timelinePageOrdered(sample.wire))
      throw new Error(`export-vectors: ${sample.name} should be ordered`)
  for (const sample of ordering.refused)
    if (timelinePageOrdered(sample.wire))
      throw new Error(`export-vectors: ${sample.name} should break the ordering rule`)
  return {
    file: 'timeline.json',
    schemas: f.schemas,
    data: {
      ...header('timeline', [
        'GET /sessions/timeline answers the ordered history: identity is the position (a generation and a sequence), never the text; a new generation needs a new snapshot.',
        'The `ordering` block is the phone’s rule (docs/mobile-timeline.md), not the contract’s: the contract accepts every page in it, the phone refuses the four under `refused`.'
      ]),
      shapes: {
        SessionPosition: f.shape(
          'SessionPosition',
          Timeline.SessionPosition,
          [
            ['a position', cursor],
            ['the empty snapshot’s position', { generation: 'g', sequence: 0 }]
          ],
          [
            [
              'an empty generation',
              { generation: '', sequence: 1 },
              'generation is a non-empty string'
            ],
            ['a negative sequence', { generation: 'g', sequence: -1 }, 'sequence is 0 or more'],
            ['a fractional sequence', { generation: 'g', sequence: 0.5 }, 'sequence is an integer'],
            [
              'a sequence beyond the safe integers',
              { generation: 'g', sequence: Number.MAX_SAFE_INTEGER + 1 },
              'sequence is a safe integer'
            ],
            ['a missing sequence', { generation: 'g' }, 'sequence is required']
          ]
        ),
        TimelineItem: f.shape('TimelineItem', Timeline.TimelineItem, [
          ['an item with its time', { event: timelineEvent, position: cursor, at: 1 }],
          ['an item without a time', { event: timelineEvent, position: cursor }]
        ]),
        TimelinePage: f.shape(
          'TimelinePage',
          Timeline.TimelinePage,
          [
            ['a snapshot with two items and an older page before it', snapshot],
            ['an older page, the last one', { ...snapshot, before: null }],
            [
              'the empty snapshot',
              {
                items: [],
                before: null,
                cursor: { generation: 'g', sequence: 0 },
                truncated: false
              }
            ],
            ['a truncated snapshot', { ...snapshot, truncated: true }]
          ],
          [
            [
              'a page without truncated',
              { items: [], before: null, cursor },
              'truncated is required'
            ],
            [
              'a page without a cursor',
              { items: [], before: null, truncated: false },
              'cursor is required'
            ],
            [
              'an item without a position',
              { items: [{ event: timelineEvent }], before: null, cursor, truncated: false },
              'position is required'
            ],
            ['a negative before', { ...snapshot, before: -1 }, 'before is a sequence or null']
          ]
        )
      },
      ordering,
      commands: {
        GetSessionTimeline: f.command('GetSessionTimeline', Timeline.GetSessionTimeline, {
          payload: [
            ['the snapshot', { id: 's1' }],
            ['an older page, the numbers as query strings', { id: 's1', before: '4', limit: '200' }]
          ],
          invalidPayload: [
            ['a limit of zero', { id: 's1', limit: '0' }, 'limit is 1 to 2000'],
            ['a limit above 2000', { id: 's1', limit: '2001' }, 'limit is 1 to 2000'],
            ['a negative before', { id: 's1', before: '-1' }, 'before is 0 or more']
          ],
          success: [['the snapshot', snapshot]],
          failures: [
            failure(Sessions.SessionNotFound, { id: 's1' }),
            failure(CapabilityUnavailable, {
              capability: 'timeline',
              message: 'This server keeps no ordered history.'
            }),
            failure(Timeline.TimelineReadFailed, {
              id: 's1',
              message: 'The transcript could not be read.'
            })
          ]
        })
      }
    }
  }
}

function requestsFamily(): FamilyFile {
  const f = new Family('requests')
  const responses: Pairs = [
    ['a permission answered by an option', { type: 'permission', optionId: 'allow-once' }],
    [
      'a native question answered as a permission',
      { type: 'permission', optionId: 'answer', answers: { q: 'A' } }
    ],
    ['a clarification', { type: 'clarification', answers: { q: 'A' } }],
    ['a secret', { type: 'secret', value: 'shh' }],
    ['a dismissal', { type: 'dismiss' }]
  ]
  return {
    file: 'requests.json',
    schemas: f.schemas,
    data: {
      ...header('requests', [
        'GET /requests/pending lists what agents are waiting on; POST /requests/resolve answers one. A server without the requests port answers CapabilityUnavailable and the chat’s own permission cards answer through POST /sessions/write instead.',
        'A secret’s value travels in the resolve body and nowhere else; the snapshot never carries one.'
      ]),
      literals: {
        RequestKind: literalsOf(Requests.PendingRequest.fields.kind, 'PendingRequest.kind'),
        RequestRejectedCode: literalsOf(
          Requests.RequestRejected.fields.code,
          'RequestRejected.code'
        )
      },
      shapes: {
        PendingRequest: f.shape(
          'PendingRequest',
          Requests.PendingRequest,
          [
            ['a clarification with a native question', request],
            ['a permission with options', permissionRequest],
            ['a secret going to an env file', secretRequest],
            ['a secret handed to a command', secretRunRequest]
          ],
          [
            [
              'an unknown kind',
              { ...permissionRequest, kind: 'other' },
              'kind is permission, clarification or secret'
            ],
            [
              'an empty description',
              { ...permissionRequest, description: '' },
              'description is 1 to 16384 characters'
            ],
            [
              'an unknown action type',
              { ...secretRequest, action: { type: 'exec', file: '/x', key: 'K' } },
              'action is run or env-file'
            ],
            [
              'a run action with a lowercase variable',
              { ...secretRunRequest, action: { ...secretRunRequest.action, envVar: 'token' } },
              'envVar is an uppercase identifier'
            ]
          ]
        ),
        RequestSnapshot: f.shape('RequestSnapshot', Requests.RequestSnapshot, [
          ['two pending requests', { revision: 2, pending: [request, permissionRequest] }],
          ['nothing pending', { revision: 0, pending: [] }]
        ]),
        RequestResponse: f.shape('RequestResponse', Requests.RequestResponse, responses, [
          [
            'an unknown type',
            { type: 'approve' },
            'type is permission, clarification, secret or dismiss'
          ],
          ['an empty secret', { type: 'secret', value: '' }, 'value is 1 to 16384 characters'],
          ['a clarification without answers', { type: 'clarification' }, 'answers is required']
        ])
      },
      commands: {
        ListPendingRequests: f.command('ListPendingRequests', Requests.ListPendingRequests, {
          payload: [['everything pending', {}]],
          success: [
            ['two pending requests', { revision: 2, pending: [request, permissionRequest] }]
          ],
          failures: [
            failure(CapabilityUnavailable, {
              capability: 'requests',
              message: 'This server holds no requests.'
            })
          ]
        }),
        ResolvePendingRequest: f.command('ResolvePendingRequest', Requests.ResolvePendingRequest, {
          payload: responses.map(
            ([name, response]) => [name, { requestId: 'req-1', response }] as const
          ),
          invalidPayload: [
            [
              'an empty request id',
              { requestId: '', response: { type: 'dismiss' } },
              'requestId is 1 to 256 characters'
            ],
            [
              'an unknown response',
              { requestId: 'req-1', response: { type: 'approve' } },
              'response is one of the four'
            ]
          ],
          success: [
            ['accepted', { accepted: true }],
            ['not accepted', { accepted: false }]
          ],
          failures: [
            ...(['invalid', 'not_found', 'capacity', 'closed'] as const).map((code) =>
              failure(Requests.RequestRejected, {
                code,
                message: `The request was rejected (${code}).`
              })
            ),
            failure(CapabilityUnavailable, {
              capability: 'requests',
              message: 'This server holds no requests.'
            })
          ]
        })
      }
    }
  }
}

function settingsFamily(): FamilyFile {
  const f = new Family('settings')
  return {
    file: 'settings.json',
    schemas: f.schemas,
    data: {
      ...header('settings', [
        'The two settings reads a phone makes: GET /launch-profiles and GET /workspaces. Every other settings route refuses a device session.',
        'The chat profiles are the ones to offer on a phone; the terminal built-ins are the Mac’s own constant and are not listed by the server.'
      ]),
      literals: {
        LauncherFamily: literalsOf(Settings.LauncherFamily, 'LauncherFamily'),
        PiThinkingLevel: literalsOf(Settings.PiThinkingLevel, 'PiThinkingLevel')
      },
      shapes: {
        LaunchProfileView: f.shape(
          'LaunchProfileView',
          Settings.LaunchProfileView,
          [
            ['a built-in chat variant', chatProfile],
            ['a Pi profile with its provider, model and thinking level', piProfile]
          ],
          [
            [
              'an unknown family',
              { ...chatProfile, family: 'gemini' },
              'family is claude, antigravity, codex or pi'
            ],
            [
              'a command that is not a list',
              { ...chatProfile, command: 'claude' },
              'command is an array of strings'
            ]
          ]
        ),
        LaunchProfilePreferencesView: f.shape(
          'LaunchProfilePreferencesView',
          Settings.LaunchProfilePreferencesView,
          [['two profiles, a global default and a workspace override', launchProfiles]],
          [
            [
              'a version the contract does not know',
              { ...launchProfiles, version: 2 },
              'version is 1'
            ]
          ]
        ),
        WorkspaceView: f.shape(
          'WorkspaceView',
          Settings.WorkspaceView,
          [
            ['a bare workspace', workspace],
            [
              'a workspace with a profile file',
              {
                ...workspace,
                id: 'ws2',
                name: 'Site',
                rootDir: '/tmp/site',
                profileFile: '/tmp/site/.clave/workspaces/default.clave'
              }
            ]
          ],
          [
            [
              'a workspace without profileFile',
              { id: 'ws1', name: 'scratch', rootDir: '/tmp/scratch', createdAt: 1 },
              'profileFile is a string or null'
            ]
          ]
        ),
        WorkspaceStateView: f.shape(
          'WorkspaceStateView',
          Settings.WorkspaceStateView,
          [['one workspace, its pins opaque', workspaces]],
          [
            ['a version the contract does not know', { ...workspaces, version: 2 }, 'version is 1'],
            ['pins that are not a list', { ...workspaces, pins: {} }, 'pins is an array']
          ]
        )
      },
      commands: {
        ListLaunchProfiles: f.command('ListLaunchProfiles', Settings.ListLaunchProfiles, {
          payload: [['the profiles', {}]],
          success: [['two profiles, a global default and a workspace override', launchProfiles]]
        }),
        LoadWorkspaceState: f.command('LoadWorkspaceState', Settings.LoadWorkspaceState, {
          payload: [['the registry', {}]],
          success: [['one workspace, its pins opaque', workspaces]]
        })
      }
    }
  }
}

function filesFamily(): FamilyFile {
  const f = new Family('files')
  const png1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  const upload = {
    sessionId: 's1',
    source: { kind: 'upload', name: 'Fixture.png', base64: png1x1, image: true }
  }
  const fileSource = {
    sessionId: 's1',
    source: { kind: 'file', root: '/tmp/scratch', path: 'notes/plan.md' }
  }
  const attachment = {
    id: 'att-1',
    path: '/tmp/attachments/Fixture.png',
    name: 'Fixture.png',
    mimeType: 'image/png',
    size: 70,
    delivery: 'image'
  }
  return {
    file: 'files.json',
    schemas: f.schemas,
    data: {
      ...header('files', [
        'A device session may GET anything under /files/ and POST exactly /files/attachments/prepare; writes, uploads, creates and mkdirs under /files/ refuse it.',
        'Paths are the server’s; `root` bounds every operation, symlinks included. An upload is base64 of at most MAX_TRANSFER_BYTES.'
      ]),
      literals: {
        AttachmentDelivery: literalsOf(
          Files.FileAttachment.fields.delivery,
          'FileAttachment.delivery'
        ),
        FileOperationFailedCode: literalsOf(
          Files.FileOperationFailed.fields.code,
          'FileOperationFailed.code'
        )
      },
      constants: {
        MAX_TRANSFER_BYTES: Files.MAX_TRANSFER_BYTES,
        MAX_TEXT_BYTES: Files.MAX_TEXT_BYTES,
        MAX_PREVIEW_BYTES: Files.MAX_PREVIEW_BYTES,
        MAX_BASE64_LENGTH: Files.MAX_BASE64_LENGTH,
        MAX_FILE_ENTRIES: Files.MAX_FILE_ENTRIES,
        FILE_TREE_IGNORED: Files.FILE_TREE_IGNORED
      },
      shapes: {
        FileLocation: f.shape(
          'FileLocation',
          Files.FileLocation,
          [['a file under a root', { root: '/tmp/scratch', path: 'notes/plan.md' }]],
          [
            ['an empty path', { root: '/tmp/scratch', path: '' }, 'path is 1 to 4096 characters'],
            [
              'a path with a NUL byte',
              { root: '/tmp/scratch', path: 'a\u0000b' },
              'a path holds no NUL byte'
            ]
          ]
        ),
        FileText: f.shape(
          'FileText',
          Files.FileText,
          [
            ['a small text file', { content: '# hi', truncated: false, size: 4, binary: false }],
            [
              'a truncated text file',
              { content: 'x'.repeat(16), truncated: true, size: 2_000_000, binary: false }
            ]
          ],
          [
            [
              'a file without binary',
              { content: '', truncated: false, size: 0 },
              'binary is required'
            ]
          ]
        ),
        FileAttachment: f.shape(
          'FileAttachment',
          Files.FileAttachment,
          [
            ['an image', attachment],
            [
              'a file by reference',
              {
                ...attachment,
                id: 'att-2',
                path: '/tmp/attachments/report.pdf',
                name: 'report.pdf',
                mimeType: 'application/pdf',
                size: 1024,
                delivery: 'reference'
              }
            ],
            [
              'a folder with its entry count',
              {
                ...attachment,
                id: 'att-3',
                path: '/tmp/scratch/src',
                name: 'src',
                mimeType: 'inode/directory',
                size: 0,
                delivery: 'folder',
                entries: 3
              }
            ]
          ],
          [
            [
              'an unknown delivery',
              { ...attachment, delivery: 'inline' },
              'delivery is image, reference or folder'
            ],
            ['a name with a slash', { ...attachment, name: 'a/b.png' }, 'name holds no slash']
          ]
        ),
        AttachmentSource: f.shape('AttachmentSource', Files.AttachmentSource, [
          ['a file on the server', fileSource.source],
          ['an upload from the phone', upload.source]
        ]),
        PrepareFileAttachmentInput: f.shape(
          'PrepareFileAttachmentInput',
          Files.PrepareFileAttachmentInput,
          [
            ['an uploaded image', upload],
            ['a file on the server', fileSource]
          ],
          [
            [
              'a session id with a space',
              { ...upload, sessionId: 'has space' },
              'sessionId is 1 to 128 letters, digits, underscore or dash'
            ],
            [
              'an upload named with a slash',
              { ...upload, source: { ...upload.source, name: 'a/b.png' } },
              'name holds no slash'
            ]
          ]
        )
      },
      commands: {
        ReadFile: f.command('ReadFile', Files.ReadFile, {
          payload: [['a file under a root', { root: '/tmp/scratch', path: 'notes/plan.md' }]],
          success: [
            ['a small text file', { content: '# hi', truncated: false, size: 4, binary: false }]
          ],
          failures: [
            failure(Files.FileOperationFailed, { code: 'not_found', message: 'No such file.' }),
            failure(Files.FileOperationFailed, {
              code: 'invalid_path',
              message: 'The path leaves its root.'
            }),
            failure(CapabilityUnavailable, {
              capability: 'files',
              message: 'This server serves no files.'
            })
          ]
        }),
        PrepareFileAttachment: f.command('PrepareFileAttachment', Files.PrepareFileAttachment, {
          payload: [
            ['an uploaded image', upload],
            ['a file on the server', fileSource]
          ],
          success: [['the prepared image', attachment]],
          failures: [
            failure(Files.FileOperationFailed, {
              code: 'too_large',
              message: 'The upload is larger than 5 MiB.'
            })
          ]
        })
      }
    }
  }
}

function pushFamily(): FamilyFile {
  const f = new Family('push')
  const fullEnvelope = {
    ...envelope,
    event: { _tag: 'session.state_changed', id: 's1', state: 'done' }
  }
  return {
    file: 'push.json',
    schemas: f.schemas,
    data: {
      ...header('push', [
        'One WebSocket per client on the server’s listener at PUSH_PATH (through the relay, <relay>/m/<machineId>/push): the client says hello with its token within HELLO_TIMEOUT_MS, the server answers welcome or closes with a code below; then the client subscribes to sessions by id.',
        'A `request` frame is a view request for a desktop window; a device session never receives one. A tag a phone does not know is ignored, never a failure: the contract may add a frame later.',
        'CLOSE_DEVICE_REVOKED (devices.json) is the code a phone’s socket gets when its session is revoked.'
      ]),
      constants: {
        PUSH_PATH: Push.PUSH_PATH,
        PUSH_PROTOCOL: Push.PUSH_PROTOCOL,
        HELLO_TIMEOUT_MS: Push.HELLO_TIMEOUT_MS,
        CLOSE_UNAUTHORIZED: Push.CLOSE_UNAUTHORIZED,
        CLOSE_MALFORMED: Push.CLOSE_MALFORMED,
        CLOSE_HELLO_TIMEOUT: Push.CLOSE_HELLO_TIMEOUT,
        CLOSE_SERVER_STOPPING: Push.CLOSE_SERVER_STOPPING,
        CLOSE_DEVICE_REVOKED: Devices.CLOSE_DEVICE_REVOKED
      },
      literals: {
        ClientFrameTag: tagsOf(Push.ClientFrame, 'ClientFrame'),
        ServerFrameTag: tagsOf(Push.ServerFrame, 'ServerFrame')
      },
      shapes: {
        ClientFrame: f.shape(
          'ClientFrame',
          Push.ClientFrame,
          [
            [
              'hello, the client named',
              { _tag: 'hello', token: deviceSession.token, client: 'clave-ios/0.1.0' }
            ],
            ['hello without a client name', { _tag: 'hello', token: deviceSession.token }],
            ['subscribe', { _tag: 'subscribe', sessionId: 's1' }],
            ['unsubscribe', { _tag: 'unsubscribe', sessionId: 's1' }],
            ['ping', { _tag: 'ping' }]
          ],
          [
            [
              'hello without a token',
              { _tag: 'hello', client: 'clave-ios/0.1.0' },
              'token is required'
            ],
            ['subscribe without a session', { _tag: 'subscribe' }, 'sessionId is required'],
            ['an unknown tag', { _tag: 'shout' }, '_tag is one of the four']
          ]
        ),
        ServerFrame: f.shape(
          'ServerFrame',
          Push.ServerFrame,
          [
            [
              'welcome with the server’s version',
              { _tag: 'welcome', serverId: 'srv-1', protocol: 1, version: '2.4.0' }
            ],
            ['welcome from an older server', { _tag: 'welcome', serverId: 'srv-1', protocol: 1 }],
            ['subscribed', { _tag: 'subscribed', sessionId: 's1', session: fullSession }],
            ['unsubscribed', { _tag: 'unsubscribed', sessionId: 's1' }],
            [
              'a streamed event with its position',
              {
                _tag: 'stream',
                sessionId: 's1',
                stream: { kind: 'event', event: timelineEvent, position: cursor }
              }
            ],
            [
              'a streamed event without a position',
              {
                _tag: 'stream',
                sessionId: 's1',
                stream: { kind: 'event', event: eventOf('assistant_text delta') }
              }
            ],
            [
              'streamed terminal bytes',
              { _tag: 'stream', sessionId: 's1', stream: { kind: 'pty', data: 'aGk=' } }
            ],
            ['exit', { _tag: 'exit', sessionId: 's1', code: 0 }],
            ['a server event', { _tag: 'event', ...fullEnvelope }],
            [
              'an error about a session',
              { _tag: 'error', sessionId: 's1', message: 'Unknown session' }
            ],
            ['an error about a frame', { _tag: 'error', message: 'Malformed frame' }],
            ['pong', { _tag: 'pong' }],
            [
              'a view request, for a desktop window and never a phone',
              {
                _tag: 'request',
                requestId: 'vr-1',
                windowKey: 'main',
                command: 'sidebar:read',
                payload: {}
              }
            ]
          ],
          [
            [
              'welcome with another protocol',
              { _tag: 'welcome', serverId: 'srv-1', protocol: 2 },
              'protocol is 1'
            ],
            [
              'terminal bytes that are not base64',
              { _tag: 'stream', sessionId: 's1', stream: { kind: 'pty', data: '***' } },
              'data is base64'
            ],
            [
              'an unknown tag',
              { _tag: 'something-new' },
              '_tag is one of the frames; a phone ignores it'
            ]
          ]
        )
      }
    }
  }
}

function eventsFamily(): FamilyFile {
  const f = new Family('events')
  const tags = tagsOf(Events.ServerEvent, 'ServerEvent')
  const env = (event: unknown, seq = 4): unknown => ({ ...envelope, seq, event })
  return {
    file: 'events.json',
    schemas: f.schemas,
    data: {
      ...header('events', [
        'Every server event rides the push channel inside the envelope frame (`_tag: event`); `seq` is the server’s order from 1, so a client can tell what it missed.',
        'A phone hears the tags under `heard` (routes.json derives them from the server’s scope): its sessions, the requests, the devices, the workspaces and the usage reads. The rest stays with the desktop.',
        'The usage events carry the accounts’ usage reads whose shape is the desktop’s; a phone only needs their tag.'
      ]),
      literals: {
        ServerEventTag: tags,
        heard: tags.filter(deviceHearsEvent),
        notHeard: tags.filter((tag) => !deviceHearsEvent(tag))
      },
      shapes: {
        ServerEventEnvelope: f.shape(
          'ServerEventEnvelope',
          Events.ServerEventEnvelope,
          [
            [
              'session.state_changed',
              env({ _tag: 'session.state_changed', id: 's1', state: 'done' })
            ],
            [
              'session.title_changed',
              env({ _tag: 'session.title_changed', id: 's1', title: 'Rename the plan' }, 5)
            ],
            [
              'session.plan_detected',
              env({ _tag: 'session.plan_detected', id: 's1', path: '/tmp/scratch/plan.md' }, 6)
            ],
            [
              'session.cleared',
              env({ _tag: 'session.cleared', id: 's1', providerSessionId: null }, 7)
            ],
            ['session.renamed', env({ _tag: 'session.renamed', id: 's1', name: 'Plan' }, 8)],
            ['session.typed', env({ _tag: 'session.typed', id: 's1', from: null }, 9)],
            ['session.restarting', env({ _tag: 'session.restarting', id: 's1' }, 10)],
            [
              'session.restarted',
              env({ _tag: 'session.restarted', id: 's1', resumed: true, account: {} }, 11)
            ],
            ['requests.changed', env({ _tag: 'requests.changed', revision: 7 }, 12)],
            [
              'workspaces.state_changed',
              env(
                {
                  _tag: 'workspaces.state_changed',
                  workspaces: [workspace],
                  pins: [],
                  origin: null,
                  revision: 4,
                  instance: 'i-1'
                },
                13
              )
            ],
            ['devices.changed', env({ _tag: 'devices.changed', revision: 2 }, 14)],
            [
              'devices.pairing_requested',
              env(
                {
                  _tag: 'devices.pairing_requested',
                  pairingId: 'pair-1',
                  name: 'Fixture Pixel',
                  platform: 'android'
                },
                15
              )
            ]
          ],
          [
            [
              'a textual seq',
              { ...envelope, seq: 'x', event: { _tag: 'requests.changed', revision: 1 } },
              'seq is a number'
            ],
            [
              'an unknown event tag',
              env({ _tag: 'something.new' }),
              '_tag is one of the server events; a phone ignores an envelope it cannot read'
            ],
            ['an envelope without an event', envelope, 'event is required']
          ]
        )
      }
    }
  }
}

function devicesFamily(): FamilyFile {
  const f = new Family('devices')
  const refusals = literalsOf(
    Devices.PairingRefusal,
    'PairingRefusal'
  ) as ReadonlyArray<Devices.PairingRefusal>
  const sentences: Record<Devices.PairingRefusal, string> = {
    format: 'The token is not a compact JWS.',
    algorithm: 'The token is not signed with RS256 or ES256.',
    keys: 'The hub’s keys could not be read: the issuer answered 503',
    key: 'The token names a key the hub does not publish.',
    signature: 'The token’s signature does not hold.',
    issuer: 'The token was not issued by the Antasphere hub.',
    expired: 'The token has expired.',
    'not-yet-valid': 'The token is not valid yet.',
    audience: 'The token was not issued to this phone.',
    'authorized-party': 'The token was not issued to this phone.',
    subject: 'The token is not the owner’s.',
    busy: 'Too many phones are waiting for an answer; try again in a few minutes.'
  }
  const idToken =
    'eyJhbGciOiJSUzI1NiIsImtpZCI6ImNsYXZlLXRlc3Qtc2lnbmluZyJ9.eyJpc3MiOiJodHRwOi8vMTI3LjAuMC4xOjQ3MzAzIiwic3ViIjoiZml4dHVyZS1vd25lciJ9.c2lnbmF0dXJl'
  return {
    file: 'devices.json',
    schemas: f.schemas,
    data: {
      ...header('devices', [
        'POST /devices/pair takes no bearer: the proof is the ID token the hub issued to the phone’s own client id; GET /devices/pair?id= answers the status and, on approved, the device session exactly once.',
        'From then on the device session is the bearer on the API and the token of the push hello. The owner approves, refuses and revokes from the Mac; the owner-only commands are listed under `owner` so a phone knows what refuses it.',
        'A refusal names the check (the sentences are the server’s today) and never the token; a server with no Antasphere login answers CapabilityUnavailable.'
      ]),
      literals: {
        DevicePlatform: literalsOf(Devices.DevicePlatform, 'DevicePlatform'),
        PairingStatus: literalsOf(Devices.PairingStatus, 'PairingStatus'),
        PairingRefusal: refusals
      },
      constants: {
        DEVICE_PAIR_PATH: Devices.DEVICE_PAIR_PATH,
        CLOSE_DEVICE_REVOKED: Devices.CLOSE_DEVICE_REVOKED
      },
      shapes: {
        DeviceDescription: f.shape(
          'DeviceDescription',
          Devices.DeviceDescription,
          [
            ['an iPhone', device],
            ['an Android phone', androidDevice]
          ],
          [
            ['an unknown platform', { ...device, platform: 'web' }, 'platform is ios or android'],
            ['an empty name', { ...device, name: '' }, 'name is 1 to 120 characters'],
            [
              'an empty app version',
              { ...device, appVersion: '' },
              'appVersion is 1 to 64 characters'
            ]
          ]
        ),
        DeviceView: f.shape(
          'DeviceView',
          Devices.DeviceView,
          [
            ['a phone never seen since the pairing', deviceView],
            ['a phone seen a minute ago', { ...deviceView, lastSeenAt: NOW + 60_000 }]
          ],
          [
            [
              'a view without lastSeenAt',
              { id: 'dev-1', name: 'P', platform: 'ios', appVersion: '1', createdAt: NOW },
              'lastSeenAt is a number or null'
            ]
          ]
        ),
        PendingPairingView: f.shape('PendingPairingView', Devices.PendingPairingView, [
          ['a phone asking', pendingPairing]
        ]),
        DeviceSessionView: f.shape('DeviceSessionView', Devices.DeviceSessionView, [
          ['the credential, shown once', deviceSession]
        ]),
        DevicesView: f.shape('DevicesView', Devices.DevicesView, [
          ['nobody paired, nobody asking', { revision: 0, devices: [], pending: [] }],
          [
            'one paired, one asking',
            { revision: 5, devices: [deviceView], pending: [pendingPairing] }
          ]
        ])
      },
      commands: {
        RequestDevicePairing: f.command('RequestDevicePairing', Devices.RequestDevicePairing, {
          payload: [
            [
              'the phone’s ID token, its client id and how it names itself',
              { idToken, clientId: 'dcr-0123456789ab', device }
            ]
          ],
          invalidPayload: [
            [
              'an empty token',
              { idToken: '', clientId: 'dcr-0123456789ab', device },
              'idToken is 1 to 16384 characters; the refusal says Invalid pairing request. and nothing of the body'
            ],
            [
              'an unknown platform',
              { idToken, clientId: 'dcr-0123456789ab', device: { ...device, platform: 'web' } },
              'platform is ios or android'
            ]
          ],
          success: [['the pairing to poll', { pairingId: 'pair-1', expiresAt: NOW + 600_000 }]],
          failures: [
            ...refusals.map((check) =>
              failure(Devices.DevicePairingRefused, { check, message: sentences[check] })
            ),
            failure(CapabilityUnavailable, {
              capability: 'devices',
              message: 'This server has no Antasphere login, so no phone can pair with it.'
            }),
            failure(CapabilityUnavailable, {
              capability: 'configuration',
              message:
                'The Antasphere issuer configured for this server is refused; no phone can pair.'
            })
          ]
        }),
        ReadDevicePairing: f.command('ReadDevicePairing', Devices.ReadDevicePairing, {
          payload: [['by pairing id', { id: 'pair-1' }]],
          success: [
            ['pending', { status: 'pending' }],
            ['approved, the session carried once', { status: 'approved', deviceSession }],
            ['approved, read again', { status: 'approved' }],
            ['refused', { status: 'refused' }],
            ['expired, or never known', { status: 'expired' }]
          ]
        }),
        ReadOwnDevice: f.command('ReadOwnDevice', Devices.ReadOwnDevice, {
          payload: [['the phone’s own record', {}]],
          success: [['the record', deviceView]],
          failures: [
            failure(Devices.DeviceSessionRequired, { message: 'This route is a phone’s.' }),
            failure(Devices.DeviceNotFound, {
              id: 'dev-1',
              message: 'No phone with that id is paired here.'
            })
          ]
        }),
        SetDevicePushToken: f.command('SetDevicePushToken', Devices.SetDevicePushToken, {
          payload: [
            ['an APNs token', { token: 'a'.repeat(64), platform: 'ios' }],
            ['an FCM token', { token: 'fcm-token-0123456789', platform: 'android' }]
          ],
          invalidPayload: [
            [
              'an empty token',
              { token: '', platform: 'ios' },
              'token is 1 to 4096 characters; the refusal says Invalid push token.'
            ]
          ],
          failures: [
            failure(Devices.DeviceSessionRequired, { message: 'This route is a phone’s.' })
          ]
        }),
        ClearDevicePushToken: f.command('ClearDevicePushToken', Devices.ClearDevicePushToken, {
          payload: [['no more notifications here', {}]]
        })
      },
      owner: {
        ListDevices: f.command('ListDevices', Devices.ListDevices, {
          payload: [['the owner’s list', {}]],
          success: [
            [
              'one paired, one asking',
              { revision: 5, devices: [deviceView], pending: [pendingPairing] }
            ]
          ]
        }),
        ApproveDevicePairing: f.command('ApproveDevicePairing', Devices.ApproveDevicePairing, {
          payload: [['by pairing id', { pairingId: 'pair-1' }]],
          success: [['the device admitted', deviceView]],
          failures: [
            failure(Devices.DevicePairingNotFound, {
              id: 'pair-1',
              message: 'The pairing is not waiting any more.'
            })
          ]
        }),
        RefuseDevicePairing: f.command('RefuseDevicePairing', Devices.RefuseDevicePairing, {
          payload: [['by pairing id', { pairingId: 'pair-1' }]],
          failures: [
            failure(Devices.DevicePairingNotFound, {
              id: 'pair-1',
              message: 'The pairing is not waiting any more.'
            })
          ]
        }),
        RevokeDevice: f.command('RevokeDevice', Devices.RevokeDevice, {
          payload: [['by device id', { deviceId: 'dev-1' }]],
          failures: [
            failure(Devices.DeviceNotFound, {
              id: 'dev-1',
              message: 'No phone with that id is paired here.'
            })
          ]
        }),
        ReadMobileRelay: f.command('ReadMobileRelay', Devices.ReadMobileRelay, {
          payload: [['the relay address', {}]],
          success: [
            ['a relay set', { url: 'https://relay.example.com' }],
            ['none', { url: '' }]
          ]
        }),
        SetMobileRelay: f.command('SetMobileRelay', Devices.SetMobileRelay, {
          payload: [
            ['an https origin', { url: 'https://relay.example.com' }],
            ['cleared', { url: '' }]
          ],
          success: [['the origin as stored', { url: 'https://relay.example.com' }]],
          failures: [
            failure(Devices.RelayAddressInvalid, {
              message: 'The relay address must be an http(s) origin.'
            })
          ]
        })
      },
      events: f.shape(
        'DevicesEvent',
        Schema.Union(Devices.DevicesChanged, Devices.DevicePairingRequested) as AnySchema,
        [
          ['devices.changed', { _tag: 'devices.changed', revision: 2 }],
          [
            'devices.pairing_requested, for the Mac and never a phone',
            {
              _tag: 'devices.pairing_requested',
              pairingId: 'pair-1',
              name: 'Fixture Pixel',
              platform: 'android'
            }
          ]
        ]
      )
    }
  }
}

function relayFamily(): FamilyFile {
  const f = new Family('relay')
  const roads = [
    '/m/m_0123456789abcdef/sessions?windowKey=w',
    '/m/m_0123456789abcdef',
    '/m/m_0123456789abcdef/push',
    '/m/bad id/sessions',
    '/sessions',
    `/m/${'a'.repeat(65)}/sessions`
  ]
  return {
    file: 'relay.json',
    schemas: f.schemas,
    data: {
      ...header('relay', [
        'A phone holding a bearer of the hub lists its own machines at GET /machines and reaches one at <relay>/m/<machineId>/<path>, the request forwarded to the machine as received, the device session’s Authorization included; WS <relay>/m/<machineId>/push is the push channel tunnelled.',
        'The relay answers 404 for a machine it does not know, 503 for one offline or too busy, 413 beyond RELAY_MAX_BODY_BYTES, 504 past RELAY_REQUEST_TIMEOUT_MS, 502 when the machine could not perform the request; the machine’s own listener answers everything else, 401 included.',
        'The claim, the connect socket and the machine frames are the server’s road, not a phone’s; they are listed for completeness under `machine`.'
      ]),
      literals: { MachinePlatform: literalsOf(Relay.MachinePlatform, 'MachinePlatform') },
      constants: {
        RELAY_PROTOCOL: Relay.RELAY_PROTOCOL,
        RELAY_CONNECT_PATH: Relay.RELAY_CONNECT_PATH,
        RELAY_CLAIM_PATH: Relay.RELAY_CLAIM_PATH,
        RELAY_MACHINES_PATH: Relay.RELAY_MACHINES_PATH,
        RELAY_FORGET_PATH: Relay.RELAY_FORGET_PATH,
        RELAY_HEALTH_PATH: Relay.RELAY_HEALTH_PATH,
        RELAY_MACHINE_PREFIX: Relay.RELAY_MACHINE_PREFIX,
        RELAY_PUSH_PATH: Relay.RELAY_PUSH_PATH,
        RELAY_HELLO_TIMEOUT_MS: Relay.RELAY_HELLO_TIMEOUT_MS,
        RELAY_PING_MS: Relay.RELAY_PING_MS,
        RELAY_OFFLINE_MS: Relay.RELAY_OFFLINE_MS,
        RELAY_MAX_BODY_BYTES: Relay.RELAY_MAX_BODY_BYTES,
        RELAY_STREAM_THRESHOLD_BYTES: Relay.RELAY_STREAM_THRESHOLD_BYTES,
        RELAY_MAX_TUNNELS: Relay.RELAY_MAX_TUNNELS,
        RELAY_MAX_REQUESTS: Relay.RELAY_MAX_REQUESTS,
        RELAY_REQUEST_TIMEOUT_MS: Relay.RELAY_REQUEST_TIMEOUT_MS,
        RELAY_MAX_FRAME_BYTES: Relay.RELAY_MAX_FRAME_BYTES,
        RELAY_AUTH_CACHE_MS: Relay.RELAY_AUTH_CACHE_MS,
        RELAY_CLOSE_UNAUTHORIZED: Relay.RELAY_CLOSE_UNAUTHORIZED,
        RELAY_CLOSE_MALFORMED: Relay.RELAY_CLOSE_MALFORMED,
        RELAY_CLOSE_HELLO_TIMEOUT: Relay.RELAY_CLOSE_HELLO_TIMEOUT,
        RELAY_CLOSE_REPLACED: Relay.RELAY_CLOSE_REPLACED,
        RELAY_CLOSE_STOPPING: Relay.RELAY_CLOSE_STOPPING,
        RELAY_CLOSE_SILENT: Relay.RELAY_CLOSE_SILENT,
        RELAY_CLOSE_FORGOTTEN: Relay.RELAY_CLOSE_FORGOTTEN
      },
      shapes: {
        MachineView: f.shape(
          'MachineView',
          Relay.MachineView,
          [
            ['a Mac online', machine],
            ['a Mac offline, last seen kept', { ...machine, online: false }],
            [
              'a Linux machine never heard from, with a direct address',
              {
                ...machine,
                id: 'm_fedcba9876543210',
                name: 'studio',
                platform: 'linux',
                online: false,
                lastSeen: null,
                direct: [{ url: 'http://100.64.0.2:4710' }]
              }
            ]
          ],
          [
            [
              'an unknown platform',
              { ...machine, platform: 'windows' },
              'platform is macos or linux'
            ],
            ['a textual online', { ...machine, online: 'yes' }, 'online is a boolean']
          ]
        ),
        MachineList: f.shape('MachineList', Relay.MachineList, [
          ['no machine', { machines: [] }],
          [
            'two machines',
            { machines: [machine, { ...machine, id: 'm_fedcba9876543210', online: false }] }
          ]
        ]),
        RelayHealth: f.shape(
          'RelayHealth',
          Relay.RelayHealth,
          [['live, one machine online of two known', { status: 'live', machines: 2, online: 1 }]],
          [
            [
              'a status the contract does not know',
              { status: 'down', machines: 0, online: 0 },
              'status is live'
            ]
          ]
        ),
        ForgetMachine: f.shape('ForgetMachine', Relay.ForgetMachine, [
          ['by machine id', { machineId: machine.id }]
        ])
      },
      machine: {
        MachineRecord: f.shape('MachineRecord', Relay.MachineRecord, [
          [
            'a Mac with no direct address',
            { name: machine.name, platform: 'macos', version: '2.4.0', direct: [] }
          ]
        ]),
        MachineCredential: f.shape('MachineCredential', Relay.MachineCredential, [
          [
            'the credential, answered once at the claim',
            { machineId: machine.id, machineSecret: 'cms_' + '0'.repeat(48) }
          ]
        ])
      },
      derived: {
        parseMachinePath: roads.map((input) => ({ input, result: Relay.parseMachinePath(input) }))
      }
    }
  }
}

function notifyFamily(): FamilyFile {
  const f = new Family('notify')
  const categories = literalsOf(
    Notify.NotificationCategory,
    'NotificationCategory'
  ) as ReadonlyArray<Notify.NotificationCategory>
  return {
    file: 'notify.json',
    schemas: f.schemas,
    data: {
      ...header('notify', [
        'What a paired phone receives through APNs or FCM when an agent needs the person: one payload per category, its keys closed to NOTIFICATION_PAYLOAD_KEYS, never a secret value, a token or an answer.',
        'iOS reads the action category as aps.category, Android as categoryId in the data map beside the payload’s keys (NOTIFICATION_DATA_KEYS).',
        'GET /notify/status and POST /notify/test are the owner’s routes; a phone never calls them.'
      ]),
      literals: {
        NotificationCategory: categories,
        NotificationAction: literalsOf(Notify.NotificationAction, 'NotificationAction'),
        PushPlatform: literalsOf(Notify.PushPlatform, 'PushPlatform'),
        SendOutcome: ['sent', 'gone', 'failed']
      },
      constants: {
        NOTIFICATION_PAYLOAD_KEYS: Notify.NOTIFICATION_PAYLOAD_KEYS,
        NOTIFICATION_DATA_KEYS: Notify.NOTIFICATION_DATA_KEYS,
        categoryIds: Object.fromEntries(
          categories.map((category) => [category, Notify.notificationCategoryId(category)])
        )
      },
      shapes: {
        NotificationPayload: f.shape(
          'NotificationPayload',
          Notify.NotificationPayload,
          [
            [
              'a question',
              notification('question', 'Which branch do we ship from?', ['reply', 'open'], {
                requestId: 'req-1'
              })
            ],
            [
              'a permission',
              notification('permission', 'Run `ls`?', ['allow', 'deny', 'open'], {
                requestId: 'req-2'
              })
            ],
            [
              'a secret asked',
              notification('secret', 'The API key for the service', ['open'], {
                requestId: 'req-3'
              })
            ],
            ['a session finished', notification('finished', 'A chat finished', ['open'])],
            ['a session failed', notification('failed', 'A chat failed', ['open'])],
            [
              'an account near its limit',
              notification(
                'account_limit',
                'Claude (machine login): 5% left of the 5h window',
                ['open'],
                { sessionId: '', sessionTitle: '', workspaceName: undefined }
              )
            ],
            ['a test push', notification('test', 'A test notification from Fixture Mac', ['open'])]
          ],
          [
            [
              'an unknown category',
              notification('news', 'x', ['open']),
              'category is one of the seven'
            ],
            [
              'an unknown action',
              notification('question', 'x', ['snooze']),
              'actions are allow, deny, reply or open'
            ],
            [
              'a payload without text',
              {
                category: 'finished',
                serverId: 'srv-1',
                serverName: 'Fixture Mac',
                sessionId: 's1',
                sessionTitle: 'A chat',
                actions: ['open']
              },
              'text is required'
            ]
          ]
        ),
        NotifyStatus: f.shape('NotifyStatus', Notify.NotifyStatus, [
          [
            'the recording fake standing in for both transports',
            {
              transports: { ios: true, android: true },
              fake: true,
              targets: 1,
              serverName: 'Fixture Mac'
            }
          ]
        ]),
        SendResultView: f.shape('SendResultView', Notify.SendResultView, [
          ['sent', { outcome: 'sent' }],
          ['gone', { outcome: 'gone' }],
          ['failed', { outcome: 'failed', reason: 'BadDeviceToken' }]
        ])
      },
      owner: {
        GetNotifyStatus: f.command('GetNotifyStatus', Notify.GetNotifyStatus, {
          payload: [['the status', {}]],
          success: [
            [
              'the recording fake standing in for both transports',
              {
                transports: { ios: true, android: true },
                fake: true,
                targets: 1,
                serverName: 'Fixture Mac'
              }
            ]
          ],
          failures: [
            failure(CapabilityUnavailable, {
              capability: 'notify',
              message: 'This server sends no notifications.'
            })
          ]
        }),
        SendTestNotification: f.command('SendTestNotification', Notify.SendTestNotification, {
          payload: [['to one phone', { deviceId: 'dev-1' }]],
          success: [
            [
              'sent to an iPhone',
              { deviceId: 'dev-1', platform: 'ios', result: { outcome: 'sent' } }
            ]
          ],
          failures: [failure(Notify.PushTargetNotFound, { deviceId: 'dev-1' })]
        })
      }
    }
  }
}

interface Endpoint {
  readonly name: string
  readonly path: string
  readonly method: string
}
interface Group {
  readonly identifier: string
  readonly endpoints: Record<string, Endpoint>
}

function routesFamily(): FamilyFile {
  const groups = (ClaveApi as unknown as { groups: Record<string, Group> }).groups
  const routes = Object.values(groups)
    .flatMap((group) =>
      Object.values(group.endpoints).map((endpoint) => ({
        group: group.identifier,
        name: endpoint.name,
        method: endpoint.method,
        path: endpoint.path,
        device: deviceMayCall(endpoint.method, endpoint.path)
      }))
    )
    .sort(
      (a, b) =>
        a.group.localeCompare(b.group) ||
        a.path.localeCompare(b.path) ||
        a.method.localeCompare(b.method)
    )
  const tags = tagsOf(Events.ServerEvent, 'ServerEvent')
  const allowed = (method: string): string[] =>
    routes.filter((r) => r.device && r.method === method).map((r) => r.path)
  const probe = (method: string, probePath: string, prefix: string): string[] =>
    deviceMayCall(method, probePath) && !routes.some((r) => r.path === probePath) ? [prefix] : []
  return {
    file: 'routes.json',
    schemas: {},
    data: {
      ...header('routes', [
        'Every route of the server’s API, read off the API’s own groups: the method, the path, the command or query behind it, and whether a device session may call it (packages/server/src/devices/scope.ts). A query is a GET with its payload as query strings; a command is a POST with a JSON body.',
        'A route a device session may not call answers 403 with the sentence under `scope.forbiddenMessage`; a route it may call authenticates it like any caller, so a bad token is 401.',
        'The health routes take no bearer. The push channel is a WebSocket at `push.path` on the same listener.'
      ]),
      routes,
      scope: {
        forbiddenMessage: DEVICE_FORBIDDEN_MESSAGE,
        GET: [
          ...allowed('GET'),
          ...probe('GET', '/files/anything-at-all', '/files/').map((p) => `${p}*`)
        ],
        POST: allowed('POST')
      },
      events: {
        heard: tags.filter(deviceHearsEvent),
        notHeard: tags.filter((tag) => !deviceHearsEvent(tag)),
        heardPrefixes: ['session.', 'usage.'].filter((prefix) =>
          deviceHearsEvent(`${prefix}anything-at-all`)
        )
      },
      push: { path: Push.PUSH_PATH },
      health: routes.filter((r) => r.group === 'health').map((r) => r.path)
    }
  }
}

// ── The export ───────────────────────────────────────────────────────────

export interface Vectors {
  /** File name under FIXTURES_DIR → the JSON text, index.json included. */
  readonly files: Map<string, string>
  /** family → shape or `<Command>.payload` / `<Command>.success` → schema. */
  readonly schemas: Record<string, Record<string, AnySchema>>
}

/** Every vector file, built from the contract as it is now. */
export function buildVectors(): Vectors {
  const families = [
    sessionsFamily(),
    timelineFamily(),
    requestsFamily(),
    settingsFamily(),
    filesFamily(),
    pushFamily(),
    eventsFamily(),
    devicesFamily(),
    relayFamily(),
    notifyFamily(),
    routesFamily()
  ]
  const files = new Map<string, string>()
  const schemas: Record<string, Record<string, AnySchema>> = {}
  for (const family of families) {
    files.set(family.file, json(family.data))
    schemas[family.data.family as string] = family.schemas
  }
  const index = {
    $comment: `The fixture vectors both native phones test against, exported from the real contract by ${GENERATOR}; this index names every file with its hash. Do not edit.`,
    contract: CONTRACT_VERSION,
    generatedBy: GENERATOR,
    files: Object.fromEntries(
      [...files.entries()].map(([name, text]) => [
        name,
        { sha256: sha256(text), bytes: Buffer.byteLength(text) }
      ])
    )
  }
  files.set(INDEX_FILE, json(index))
  return { files, schemas }
}

function main(argv: ReadonlyArray<string>): void {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repo = path.resolve(here, '..', '..', '..')
  const dir = path.join(repo, FIXTURES_DIR)
  const { files } = buildVectors()
  const onDisk = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
  const stray = onDisk.filter((f) => !files.has(f))
  if (argv.includes('--check')) {
    const differ: string[] = []
    for (const [name, text] of files) {
      const file = path.join(dir, name)
      if (!existsSync(file)) differ.push(`${name} (missing)`)
      else if (readFileSync(file, 'utf8') !== text) differ.push(name)
    }
    for (const name of stray) differ.push(`${name} (not generated)`)
    if (differ.length) {
      for (const d of differ) console.error(`differs: ${FIXTURES_DIR}/${d}`)
      console.error(
        `${differ.length} file(s) out of date: run \`npm run vectors --workspace @clave/mobile-native\``
      )
      process.exit(1)
    }
    console.log(`${files.size} files match`)
    return
  }
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of files) writeFileSync(path.join(dir, name), text)
  if (stray.length) console.error(`not generated, left in place: ${stray.join(', ')}`)
  let bytes = 0
  for (const text of files.values()) bytes += Buffer.byteLength(text)
  console.log(`wrote ${files.size} files (${bytes} bytes) to ${FIXTURES_DIR}`)
}

if ((import.meta as unknown as { main?: boolean }).main) main(process.argv.slice(2))
