/**
 * The decoders of the mirror (`types.ts`): each one takes what `JSON.parse`
 * gave and answers the typed value or throws a `DecodeError` naming the
 * path. They are deliberately plain: no schema library on the phone, the
 * shapes pinned to the contract by `contract-pin.test.ts`.
 *
 * Two rules, the contract's own: a field the shape does not name is kept out
 * of the typed value's contract but left on the object (Effect's structs
 * ignore excess properties, so does this), and a session event or a server
 * event of a kind this file does not know is carried through by its tag,
 * since the reducer and the store ignore what they do not read.
 */
import type {
  AgentQuestion,
  AgentState,
  Attachment,
  FileText,
  HistoryPage,
  LaunchProfilePreferencesView,
  LaunchProfileView,
  PendingRequest,
  RequestSnapshot,
  ResolveOutcome,
  SecretAction,
  ServerEvent,
  ServerEventEnvelope,
  ServerFailure,
  ServerFrame,
  Session,
  SessionCapabilities,
  SessionEvent,
  SessionInfo,
  SessionRecord,
  SessionStream,
  WorkspaceStateView,
  WorkspaceView,
  WriteStatus
} from './types'

export class DecodeError extends Error {
  constructor(
    readonly path: string,
    readonly expected: string
  ) {
    super(`${path}: expected ${expected}`)
    this.name = 'DecodeError'
  }
}

type Rec = Record<string, unknown>
const fail = (path: string, expected: string): never => {
  throw new DecodeError(path, expected)
}
const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const record = (value: unknown, path: string): Rec =>
  isRecord(value) ? value : fail(path, 'an object')
const str = (value: unknown, path: string): string =>
  typeof value === 'string' ? value : fail(path, 'a string')
const nonEmpty = (value: unknown, path: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fail(path, 'a non-empty string')
const num = (value: unknown, path: string): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fail(path, 'a number')
const bool = (value: unknown, path: string): boolean =>
  typeof value === 'boolean' ? value : fail(path, 'a boolean')
const opt =
  <T>(decode: (value: unknown, path: string) => T) =>
  (value: unknown, path: string): T | undefined =>
    value === undefined ? undefined : decode(value, path)
const nullable =
  <T>(decode: (value: unknown, path: string) => T) =>
  (value: unknown, path: string): T | null =>
    value === null ? null : decode(value, path)
const arr =
  <T>(decode: (value: unknown, path: string) => T) =>
  (value: unknown, path: string): T[] =>
    Array.isArray(value)
      ? value.map((item, index) => decode(item, `${path}[${index}]`))
      : fail(path, 'an array')
const lit =
  <const L extends readonly string[]>(...literals: L) =>
  (value: unknown, path: string): L[number] =>
    typeof value === 'string' && literals.includes(value)
      ? (value as L[number])
      : fail(path, `one of ${literals.join(', ')}`)
/** Adds the optional fields that are present, so `undefined` never lands on
 *  a key the wire did not carry (a strict equality with the contract's
 *  decoded value depends on it). */
const present = <T extends object>(value: T): T => {
  for (const key of Object.keys(value) as (keyof T)[])
    if (value[key] === undefined) delete value[key]
  return value
}

// ── sessions ──

const agentState = lit('idle', 'working', 'blocked', 'done', 'ended')
export const decodeAgentState = (value: unknown, path = 'state'): AgentState =>
  agentState(value, path)

export function decodeSession(value: unknown, path = 'session'): Session {
  const o = record(value, path)
  return present({
    id: nonEmpty(o.id, `${path}.id`),
    provider: nonEmpty(o.provider, `${path}.provider`),
    transport: lit('pty', 'events')(o.transport, `${path}.transport`),
    cwd: str(o.cwd, `${path}.cwd`),
    windowKey: str(o.windowKey, `${path}.windowKey`),
    groupId: opt(str)(o.groupId, `${path}.groupId`),
    state: agentState(o.state, `${path}.state`),
    createdAt: num(o.createdAt, `${path}.createdAt`),
    adapterId: nonEmpty(o.adapterId, `${path}.adapterId`),
    title: str(o.title, `${path}.title`),
    viewId: opt(nonEmpty)(o.viewId, `${path}.viewId`)
  })
}
export const decodeSessions = (value: unknown, path = 'sessions'): Session[] =>
  arr(decodeSession)(value, path)

function decodeAttachment(value: unknown, path: string): Attachment {
  const o = record(value, path)
  const delivery = str(o.delivery, `${path}.delivery`)
  if (delivery === 'session')
    return present({
      id: nonEmpty(o.id, `${path}.id`),
      label: opt(str)(o.label, `${path}.label`),
      delivery: 'session' as const,
      sessionId: nonEmpty(o.sessionId, `${path}.sessionId`),
      name: nonEmpty(o.name, `${path}.name`),
      agent: nonEmpty(o.agent, `${path}.agent`),
      cwd: str(o.cwd, `${path}.cwd`)
    })
  return present({
    id: nonEmpty(o.id, `${path}.id`),
    label: opt(str)(o.label, `${path}.label`),
    path: nonEmpty(o.path, `${path}.path`),
    name: nonEmpty(o.name, `${path}.name`),
    mimeType: nonEmpty(o.mimeType, `${path}.mimeType`),
    size: num(o.size, `${path}.size`),
    delivery: lit('reference', 'image', 'folder')(delivery, `${path}.delivery`),
    entries: opt(num)(o.entries, `${path}.entries`)
  })
}

export function decodeAgentQuestion(value: unknown, path = 'question'): AgentQuestion {
  const o = record(value, path)
  return present({
    id: opt(nonEmpty)(o.id, `${path}.id`),
    question: str(o.question, `${path}.question`),
    header: opt(str)(o.header, `${path}.header`),
    options: arr((item, p) => {
      const option = record(item, p)
      return present({
        label: str(option.label, `${p}.label`),
        description: opt(str)(option.description, `${p}.description`)
      })
    })(o.options, `${path}.options`),
    multiSelect: opt(bool)(o.multiSelect, `${path}.multiSelect`)
  })
}

const idLabel = (value: unknown, path: string): { id: string; label: string } => {
  const o = record(value, path)
  return { id: str(o.id, `${path}.id`), label: str(o.label, `${path}.label`) }
}

export function decodeSessionEvent(value: unknown, path = 'event'): SessionEvent {
  const o = record(value, path)
  const type = str(o.type, `${path}.type`)
  switch (type) {
    case 'user_message':
      return present({
        type,
        text: str(o.text, `${path}.text`),
        attachments: opt(arr(decodeAttachment))(o.attachments, `${path}.attachments`)
      })
    case 'assistant_text':
      return { type, delta: str(o.delta, `${path}.delta`), final: bool(o.final, `${path}.final`) }
    case 'tool_call':
      return present({
        type,
        id: str(o.id, `${path}.id`),
        name: str(o.name, `${path}.name`),
        input: o.input,
        parent: opt(str)(o.parent, `${path}.parent`)
      })
    case 'tool_result':
      return present({
        type,
        id: str(o.id, `${path}.id`),
        output: o.output,
        error: opt(bool)(o.error, `${path}.error`)
      })
    case 'permission_request':
      return present({
        type,
        id: str(o.id, `${path}.id`),
        description: str(o.description, `${path}.description`),
        options: arr(idLabel)(o.options, `${path}.options`),
        toolName: opt(str)(o.toolName, `${path}.toolName`),
        input: o.input,
        detail: opt(str)(o.detail, `${path}.detail`),
        questions: opt(arr(decodeAgentQuestion))(o.questions, `${path}.questions`)
      })
    case 'state_change':
      return { type, state: agentState(o.state, `${path}.state`) }
    case 'session_meta':
      return {
        type,
        model: nullable(str)(o.model, `${path}.model`),
        providerSessionId: nullable(str)(o.providerSessionId, `${path}.providerSessionId`)
      }
    case 'effort':
      return { type, effort: nullable(str)(o.effort, `${path}.effort`) }
    case 'error':
      return {
        type,
        message: str(o.message, `${path}.message`),
        fatal: bool(o.fatal, `${path}.fatal`)
      }
    case 'turn_interrupted':
      return { type }
    case 'context_usage':
      return present({
        type,
        used: num(o.used, `${path}.used`),
        window: nullable(num)(o.window, `${path}.window`),
        parent: opt(str)(o.parent, `${path}.parent`)
      })
    case 'subagent_model':
      return { type, parent: str(o.parent, `${path}.parent`), model: str(o.model, `${path}.model`) }
    case 'permission_mode':
      return {
        type,
        mode: str(o.mode, `${path}.mode`),
        modes: arr(idLabel)(o.modes, `${path}.modes`)
      }
    case 'background_tasks':
      return {
        type,
        tasks: arr((item, p) => {
          const task = record(item, p)
          return present({
            id: str(task.id, `${p}.id`),
            kind: lit('shell', 'agent', 'other')(task.kind, `${p}.kind`),
            description: str(task.description, `${p}.description`),
            toolUseId: opt(str)(task.toolUseId, `${p}.toolUseId`),
            startedAt: num(task.startedAt, `${p}.startedAt`),
            outputFile: opt(str)(task.outputFile, `${p}.outputFile`),
            model: opt(str)(task.model, `${p}.model`)
          })
        })(o.tasks, `${path}.tasks`)
      }
    case 'provider_event':
      return { type, provider: str(o.provider, `${path}.provider`), payload: o.payload }
    default:
      return fail(`${path}.type`, 'a known session event type')
  }
}

export function decodeSessionStream(value: unknown, path = 'stream'): SessionStream {
  const o = record(value, path)
  const kind = str(o.kind, `${path}.kind`)
  if (kind === 'pty') return { kind, data: str(o.data, `${path}.data`) }
  if (kind === 'event') return { kind, event: decodeSessionEvent(o.event, `${path}.event`) }
  return fail(`${path}.kind`, 'pty or event')
}

export function decodeHistoryPage(value: unknown, path = 'history'): HistoryPage {
  const o = record(value, path)
  return {
    items: arr((item, p) => {
      const entry = record(item, p)
      return present({
        event: decodeSessionEvent(entry.event, `${p}.event`),
        at: opt(num)(entry.at, `${p}.at`)
      })
    })(o.items, `${path}.items`),
    before: nullable(num)(o.before, `${path}.before`)
  }
}

export function decodeSessionInfo(value: unknown, path = 'info'): SessionInfo {
  const o = record(value, path)
  return present({
    id: nonEmpty(o.id, `${path}.id`),
    cwd: str(o.cwd, `${path}.cwd`),
    folderName: str(o.folderName, `${path}.folderName`),
    alive: bool(o.alive, `${path}.alive`),
    claudeSessionId: nullable(str)(o.claudeSessionId, `${path}.claudeSessionId`),
    piSessionId: nullable(str)(o.piSessionId, `${path}.piSessionId`),
    launchProfileId: opt(str)(o.launchProfileId, `${path}.launchProfileId`),
    model: opt(str)(o.model, `${path}.model`),
    piProvider: opt(str)(o.piProvider, `${path}.piProvider`),
    piThinking: opt(str)(o.piThinking, `${path}.piThinking`)
  })
}

export function decodeSessionCapabilities(
  value: unknown,
  path = 'capabilities'
): SessionCapabilities {
  const o = record(value, path)
  return { images: bool(o.images, `${path}.images`) }
}

export function decodeSessionRecord(value: unknown, path = 'record'): SessionRecord {
  const o = record(value, path)
  return present({
    id: nonEmpty(o.id, `${path}.id`),
    cwd: str(o.cwd, `${path}.cwd`),
    folderName: str(o.folderName, `${path}.folderName`),
    workspaceId: opt(str)(o.workspaceId, `${path}.workspaceId`),
    displayName: opt(str)(o.displayName, `${path}.displayName`),
    launchProfileId: opt(str)(o.launchProfileId, `${path}.launchProfileId`),
    live: opt(bool)(o.live, `${path}.live`),
    running: opt(bool)(o.running, `${path}.running`)
  })
}
export const decodeSessionRecords = (value: unknown, path = 'records'): SessionRecord[] =>
  arr(decodeSessionRecord)(value, path)

export function decodeWriteStatus(value: unknown, path = 'writeStatus'): WriteStatus {
  const o = record(value, path)
  return present({
    status: lit('accepted', 'pending', 'rejected', 'absent', 'unknown')(o.status, `${path}.status`),
    at: opt(num)(o.at, `${path}.at`),
    reason: opt(str)(o.reason, `${path}.reason`)
  })
}

// ── launch profiles ──

const family = lit('claude', 'antigravity', 'codex', 'pi')

export function decodeLaunchProfile(value: unknown, path = 'profile'): LaunchProfileView {
  const o = record(value, path)
  const pi = o.pi === undefined ? undefined : record(o.pi, `${path}.pi`)
  return present({
    id: str(o.id, `${path}.id`),
    name: str(o.name, `${path}.name`),
    family: family(o.family, `${path}.family`),
    command: arr(str)(o.command, `${path}.command`),
    additionalArgs: arr(str)(o.additionalArgs, `${path}.additionalArgs`),
    builtIn: opt(bool)(o.builtIn, `${path}.builtIn`),
    sourceProfileId: opt(str)(o.sourceProfileId, `${path}.sourceProfileId`),
    pi:
      pi === undefined
        ? undefined
        : present({
            provider: opt(str)(pi.provider, `${path}.pi.provider`),
            model: opt(str)(pi.model, `${path}.pi.model`),
            thinking: opt(lit('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'))(
              pi.thinking,
              `${path}.pi.thinking`
            )
          })
  })
}

const familyDefaults = (value: unknown, path: string): Partial<Record<string, string>> => {
  const o = record(value, path)
  return present({
    claude: opt(str)(o.claude, `${path}.claude`),
    antigravity: opt(str)(o.antigravity, `${path}.antigravity`),
    codex: opt(str)(o.codex, `${path}.codex`),
    pi: opt(str)(o.pi, `${path}.pi`)
  })
}

export function decodeLaunchProfiles(
  value: unknown,
  path = 'launchProfiles'
): LaunchProfilePreferencesView {
  const o = record(value, path)
  if (o.version !== 1) fail(`${path}.version`, '1')
  const overrides = record(o.workspaceOverrides, `${path}.workspaceOverrides`)
  const workspaceOverrides: Record<string, Partial<Record<string, string>>> = {}
  for (const [key, item] of Object.entries(overrides))
    workspaceOverrides[key] = familyDefaults(item, `${path}.workspaceOverrides.${key}`)
  return {
    version: 1,
    customProfiles: arr(decodeLaunchProfile)(o.customProfiles, `${path}.customProfiles`),
    globalDefaults: familyDefaults(o.globalDefaults, `${path}.globalDefaults`),
    workspaceOverrides
  }
}

// ── workspaces ──

export function decodeWorkspace(value: unknown, path = 'workspace'): WorkspaceView {
  const o = record(value, path)
  return {
    id: str(o.id, `${path}.id`),
    name: str(o.name, `${path}.name`),
    rootDir: str(o.rootDir, `${path}.rootDir`),
    profileFile: nullable(str)(o.profileFile, `${path}.profileFile`),
    createdAt: num(o.createdAt, `${path}.createdAt`)
  }
}

export function decodeWorkspaceState(value: unknown, path = 'workspaces'): WorkspaceStateView {
  const o = record(value, path)
  if (o.version !== 1) fail(`${path}.version`, '1')
  return {
    version: 1,
    workspaces: arr(decodeWorkspace)(o.workspaces, `${path}.workspaces`),
    lastActiveWorkspaceId: nullable(str)(o.lastActiveWorkspaceId, `${path}.lastActiveWorkspaceId`),
    activeWorkspaceId: nullable(str)(o.activeWorkspaceId, `${path}.activeWorkspaceId`),
    pins: Array.isArray(o.pins) ? o.pins : fail(`${path}.pins`, 'an array'),
    pinsMigrated: bool(o.pinsMigrated, `${path}.pinsMigrated`),
    revision: num(o.revision, `${path}.revision`),
    instance: str(o.instance, `${path}.instance`)
  }
}

// ── requests ──

function decodeSecretAction(value: unknown, path: string): SecretAction {
  const o = record(value, path)
  const type = str(o.type, `${path}.type`)
  if (type === 'run')
    return {
      type,
      command: nonEmpty(o.command, `${path}.command`),
      cwd: nonEmpty(o.cwd, `${path}.cwd`),
      envVar: nonEmpty(o.envVar, `${path}.envVar`)
    }
  if (type === 'env-file')
    return { type, file: nonEmpty(o.file, `${path}.file`), key: nonEmpty(o.key, `${path}.key`) }
  return fail(`${path}.type`, 'run or env-file')
}

export function decodePendingRequest(value: unknown, path = 'request'): PendingRequest {
  const o = record(value, path)
  return present({
    id: nonEmpty(o.id, `${path}.id`),
    sessionId: nonEmpty(o.sessionId, `${path}.sessionId`),
    kind: lit('permission', 'clarification', 'secret')(o.kind, `${path}.kind`),
    description: nonEmpty(o.description, `${path}.description`),
    createdAt: num(o.createdAt, `${path}.createdAt`),
    providerRequestId: opt(nonEmpty)(o.providerRequestId, `${path}.providerRequestId`),
    options: opt(arr(idLabel))(o.options, `${path}.options`),
    questions: opt(arr(decodeAgentQuestion))(o.questions, `${path}.questions`),
    secretQuestions: opt(arr(nonEmpty))(o.secretQuestions, `${path}.secretQuestions`),
    toolName: opt(nonEmpty)(o.toolName, `${path}.toolName`),
    detail: opt(nonEmpty)(o.detail, `${path}.detail`),
    input: o.input,
    action: opt(decodeSecretAction)(o.action, `${path}.action`)
  })
}

export function decodeRequestSnapshot(value: unknown, path = 'requests'): RequestSnapshot {
  const o = record(value, path)
  return {
    revision: num(o.revision, `${path}.revision`),
    pending: arr(decodePendingRequest)(o.pending, `${path}.pending`)
  }
}

export function decodeResolveOutcome(value: unknown, path = 'resolve'): ResolveOutcome {
  const o = record(value, path)
  return { accepted: bool(o.accepted, `${path}.accepted`) }
}

// ── files ──

export function decodeFileText(value: unknown, path = 'file'): FileText {
  const o = record(value, path)
  return {
    content: str(o.content, `${path}.content`),
    truncated: bool(o.truncated, `${path}.truncated`),
    size: num(o.size, `${path}.size`),
    binary: bool(o.binary, `${path}.binary`)
  }
}

// ── failures ──

/** A 422 body as the server writes a declared failure: the tag and the
 *  message, plus the fields the phone shows. Anything else is a protocol
 *  failure to the caller, never a crash. */
export function decodeServerFailure(value: unknown, path = 'failure'): ServerFailure {
  const o = record(value, path)
  return present({
    _tag: nonEmpty(o._tag, `${path}._tag`),
    message: typeof o.message === 'string' ? o.message : `The server refused (${String(o._tag)}).`,
    capability: opt(str)(o.capability, `${path}.capability`),
    code: opt(str)(o.code, `${path}.code`),
    id: opt(str)(o.id, `${path}.id`)
  })
}

// ── events and push frames ──

export function decodeServerEvent(value: unknown, path = 'event'): ServerEvent {
  const o = record(value, path)
  const tag = nonEmpty(o._tag, `${path}._tag`)
  switch (tag) {
    case 'requests.changed':
      return { _tag: tag, revision: num(o.revision, `${path}.revision`) }
    case 'session.state_changed':
      return { _tag: tag, id: str(o.id, `${path}.id`), state: agentState(o.state, `${path}.state`) }
    case 'session.title_changed':
      return { _tag: tag, id: str(o.id, `${path}.id`), title: str(o.title, `${path}.title`) }
    case 'session.renamed':
      return { _tag: tag, id: str(o.id, `${path}.id`), name: str(o.name, `${path}.name`) }
    case 'workspaces.state_changed':
      return {
        _tag: tag,
        workspaces: arr(decodeWorkspace)(o.workspaces, `${path}.workspaces`),
        revision: num(o.revision, `${path}.revision`),
        instance: str(o.instance, `${path}.instance`)
      }
    default:
      return { _tag: 'unknown', tag }
  }
}

export function decodeServerEventEnvelope(value: unknown, path = 'envelope'): ServerEventEnvelope {
  const o = record(value, path)
  return {
    id: str(o.id, `${path}.id`),
    seq: num(o.seq, `${path}.seq`),
    at: num(o.at, `${path}.at`),
    event: decodeServerEvent(o.event, `${path}.event`)
  }
}

/** A push frame by its tag. A frame of a tag this file does not know is
 *  answered as `{ _tag: 'request' }`'s family: carried by tag, ignored. */
export function decodeServerFrame(value: unknown, path = 'frame'): ServerFrame {
  const o = record(value, path)
  const tag = nonEmpty(o._tag, `${path}._tag`)
  switch (tag) {
    case 'welcome':
      return present({
        _tag: tag,
        serverId: str(o.serverId, `${path}.serverId`),
        protocol: o.protocol === 1 ? (1 as const) : fail(`${path}.protocol`, '1'),
        version: opt(str)(o.version, `${path}.version`)
      })
    case 'subscribed':
      return {
        _tag: tag,
        sessionId: str(o.sessionId, `${path}.sessionId`),
        session: decodeSession(o.session, `${path}.session`)
      }
    case 'unsubscribed':
      return { _tag: tag, sessionId: str(o.sessionId, `${path}.sessionId`) }
    case 'stream':
      return {
        _tag: tag,
        sessionId: str(o.sessionId, `${path}.sessionId`),
        stream: decodeSessionStream(o.stream, `${path}.stream`)
      }
    case 'exit':
      return {
        _tag: tag,
        sessionId: str(o.sessionId, `${path}.sessionId`),
        code: num(o.code, `${path}.code`)
      }
    case 'event':
      return {
        _tag: tag,
        id: str(o.id, `${path}.id`),
        seq: num(o.seq, `${path}.seq`),
        at: num(o.at, `${path}.at`),
        event: decodeServerEvent(o.event, `${path}.event`)
      }
    case 'error':
      return present({
        _tag: tag,
        sessionId: opt(str)(o.sessionId, `${path}.sessionId`),
        message: str(o.message, `${path}.message`)
      })
    case 'pong':
      return { _tag: tag }
    default:
      return { _tag: 'request' }
  }
}

/** JSON text to a frame; a text that is not JSON or not a frame is `null`
 *  (the socket stays open: the desktop's client reports it, the phone's
 *  ignores it, since an unknown frame is a later server's business). */
export function parseServerFrame(text: string): ServerFrame | null {
  try {
    return decodeServerFrame(JSON.parse(text))
  } catch {
    return null
  }
}
