/**
 * The sessions domain of the wire contract: the session record, what a view
 * writes to a session, what a session streams back, and the commands and
 * queries that reach them.
 *
 * Ported field by field from `src/shared/session-model.ts` (zod), which stays
 * the renderer's copy until a lane moves the renderer onto this one. The two
 * must agree: `session-model.test.ts` holds the zod side, `sessions.test.ts`
 * here holds this one, and a change to one event is a change to both files.
 */
import { Schema } from 'effect'
import { Command, Query } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from './errors'

export const AgentState = Schema.Literal('idle', 'working', 'blocked', 'done', 'ended')
export type AgentState = typeof AgentState.Type
export const Transport = Schema.Literal('pty', 'events')
export type Transport = typeof Transport.Type

export const Session = Schema.Struct({
  id: Schema.NonEmptyString,
  provider: Schema.NonEmptyString,
  transport: Transport,
  cwd: Schema.String,
  windowKey: Schema.String,
  groupId: Schema.optional(Schema.String),
  state: AgentState,
  createdAt: Schema.Number,
  adapterId: Schema.NonEmptyString,
  title: Schema.String,
  /** The view this session is read in, `<pluginId>/<viewId>`. Absent means
   *  the host picks the first view that renders this transport. */
  viewId: Schema.optional(Schema.NonEmptyString)
})
export type Session = typeof Session.Type

// ── Attachments (src/shared/attachments.ts) ──

export const MAX_ATTACHMENTS = 10

export const Attachment = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  path: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(4096),
    Schema.filter((value) => !value.includes('\0'), { message: () => 'a path holds no NUL byte' })
  ),
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255)),
  mimeType: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  size: Schema.NonNegativeInt,
  delivery: Schema.Literal('reference', 'image')
})
export type Attachment = typeof Attachment.Type
export const Attachments = Schema.Array(Attachment).pipe(Schema.maxItems(MAX_ATTACHMENTS))

/** An image as the provider receives it, base64; main's own, never a renderer's. */
export const ProviderImage = Schema.Struct({
  name: Schema.String,
  mimeType: Schema.String,
  data: Schema.String
})
export type ProviderImage = typeof ProviderImage.Type

// ── What a view writes ──

export const UserMessage = Schema.Struct({
  type: Schema.Literal('user_message'),
  text: Schema.String,
  /** The files the reader attached, as the transcript shows them: never bytes. */
  attachments: Schema.optional(Attachments)
})
export type UserMessage = typeof UserMessage.Type
export const PreparedPrompt = Schema.Struct({
  text: Schema.String,
  images: Schema.Array(ProviderImage)
})
export type PreparedPrompt = typeof PreparedPrompt.Type
export const UserMessageInput = Schema.Struct({
  ...UserMessage.fields,
  prepared: Schema.optional(PreparedPrompt)
})
export type UserMessageInput = typeof UserMessageInput.Type
export const PermissionResponse = Schema.Struct({
  type: Schema.Literal('permission_response'),
  id: Schema.String,
  optionId: Schema.String,
  answers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String }))
})
export const Interrupt = Schema.Struct({ type: Schema.Literal('interrupt') })
export const SetModel = Schema.Struct({
  type: Schema.Literal('set_model'),
  model: Schema.NullOr(Schema.String)
})
export type SetModel = typeof SetModel.Type
/** A level as a provider spells it: a short lowercase word (src/shared/effort.ts). */
export const Effort = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9_-]{0,31}$/, { message: () => 'Invalid reasoning effort' })
)
export const SetEffort = Schema.Struct({ type: Schema.Literal('set_effort'), effort: Effort })
export type SetEffort = typeof SetEffort.Type
export const SetPermissionMode = Schema.Struct({
  type: Schema.Literal('set_permission_mode'),
  mode: Schema.String
})
export const StopTask = Schema.Struct({
  type: Schema.Literal('stop_task'),
  taskId: Schema.NonEmptyString
})
export const SessionInput = Schema.Union(
  UserMessageInput,
  PermissionResponse,
  Interrupt,
  SetModel,
  SetEffort,
  SetPermissionMode,
  StopTask
)
export type SessionInput = typeof SessionInput.Type

/** What reaches a session over the wire: a typed input, or raw bytes for a
 *  terminal, base64 on the wire and `Uint8Array` in memory. The one input the
 *  wire does not carry is a `prepared` prompt: that field is the host's to
 *  build from attachment records, never a caller's to supply, so it is not in
 *  the wire's own union and the boundary drops it from a write that carries
 *  it (a struct ignores what it does not declare). */
export const SessionBytes = Schema.Struct({
  type: Schema.Literal('bytes'),
  data: Schema.Uint8ArrayFromBase64
})
export const SessionWireInput = Schema.Union(
  UserMessage,
  PermissionResponse,
  Interrupt,
  SetModel,
  SetEffort,
  SetPermissionMode,
  StopTask
)
export type SessionWireInput = typeof SessionWireInput.Type
export const SessionWrite = Schema.Union(SessionWireInput, SessionBytes)
export type SessionWrite = typeof SessionWrite.Type

// ── What a provider offers ──

export const PermissionModeOption = Schema.Struct({ id: Schema.String, label: Schema.String })
export type PermissionModeOption = typeof PermissionModeOption.Type
export const AgentQuestion = Schema.Struct({
  question: Schema.String,
  header: Schema.optional(Schema.String),
  options: Schema.Array(
    Schema.Struct({ label: Schema.String, description: Schema.optional(Schema.String) })
  ),
  multiSelect: Schema.optional(Schema.Boolean)
})
export type AgentQuestion = typeof AgentQuestion.Type
export const EffortOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  hint: Schema.optional(Schema.String)
})
export type EffortOption = typeof EffortOption.Type
export const ModelOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  hint: Schema.optional(Schema.String),
  resolved: Schema.optional(Schema.String),
  efforts: Schema.optional(Schema.Array(EffortOption)),
  defaultEffort: Schema.optional(Schema.String)
})
export type ModelOption = typeof ModelOption.Type
export const CommandOption = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  insert: Schema.String
})
export type CommandOption = typeof CommandOption.Type
export const BackgroundTask = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal('shell', 'agent', 'other'),
  description: Schema.String,
  toolUseId: Schema.optional(Schema.String),
  startedAt: Schema.Number,
  outputFile: Schema.optional(Schema.String)
})
export type BackgroundTask = typeof BackgroundTask.Type

// ── What a session streams ──

export const SessionEvent = Schema.Union(
  UserMessage,
  Schema.Struct({
    type: Schema.Literal('assistant_text'),
    delta: Schema.String,
    final: Schema.Boolean
  }),
  Schema.Struct({
    type: Schema.Literal('tool_call'),
    id: Schema.String,
    name: Schema.String,
    input: Schema.Unknown,
    parent: Schema.optional(Schema.String)
  }),
  Schema.Struct({
    type: Schema.Literal('tool_result'),
    id: Schema.String,
    output: Schema.Unknown,
    error: Schema.optional(Schema.Boolean)
  }),
  Schema.Struct({
    type: Schema.Literal('permission_request'),
    id: Schema.String,
    description: Schema.String,
    options: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
    toolName: Schema.optional(Schema.String),
    input: Schema.optional(Schema.Unknown),
    detail: Schema.optional(Schema.String),
    questions: Schema.optional(Schema.Array(AgentQuestion))
  }),
  Schema.Struct({ type: Schema.Literal('state_change'), state: AgentState }),
  Schema.Struct({
    type: Schema.Literal('session_meta'),
    model: Schema.NullOr(Schema.String),
    providerSessionId: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({ type: Schema.Literal('effort'), effort: Schema.NullOr(Schema.String) }),
  Schema.Struct({ type: Schema.Literal('error'), message: Schema.String, fatal: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal('turn_interrupted') }),
  Schema.Struct({
    type: Schema.Literal('context_usage'),
    used: Schema.Number,
    window: Schema.NullOr(Schema.Number),
    parent: Schema.optional(Schema.String)
  }),
  Schema.Struct({
    type: Schema.Literal('subagent_model'),
    parent: Schema.String,
    model: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal('permission_mode'),
    mode: Schema.String,
    modes: Schema.Array(PermissionModeOption)
  }),
  Schema.Struct({ type: Schema.Literal('background_tasks'), tasks: Schema.Array(BackgroundTask) }),
  Schema.Struct({
    type: Schema.Literal('provider_event'),
    provider: Schema.String,
    payload: Schema.Unknown
  })
)
export type SessionEvent = typeof SessionEvent.Type

/** One frame of a session's stream: terminal bytes (base64 on the wire,
 *  `Uint8Array` in memory) or one typed event. */
export const SessionStream = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('pty'), data: Schema.Uint8ArrayFromBase64 }),
  Schema.Struct({ kind: Schema.Literal('event'), event: SessionEvent })
)
export type SessionStream = typeof SessionStream.Type
export type SessionStreamEncoded = typeof SessionStream.Encoded

export const HistoryItem = Schema.Struct({
  event: SessionEvent,
  at: Schema.optional(Schema.Number)
})
export type HistoryItem = typeof HistoryItem.Type
export const HistoryPage = Schema.Struct({
  items: Schema.Array(HistoryItem),
  before: Schema.NullOr(Schema.Number)
})
export type HistoryPage = typeof HistoryPage.Type

// ── Starting and stopping ──

/** Who owns a session that is not a tab of its own, as the shell records it
 *  (`src/shared/session-link.ts`): a group's terminal, a pane's attached web
 *  view, a toolbar command. */
export const SessionLink = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('group-terminal'),
    groupId: Schema.String,
    terminalId: Schema.String
  }),
  Schema.Struct({ kind: Schema.Literal('session-view'), ownerId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('toolbar'), key: Schema.String })
)
export type SessionLink = typeof SessionLink.Type

/**
 * What a client asks a session to start with: the preload's `spawnSession`
 * options, field by field, every one optional. A field the shell adds for
 * itself (a restart's resend) is not here: the wire never carries it.
 */
export const SpawnOptions = Schema.Struct({
  dangerousMode: Schema.optional(Schema.Boolean),
  model: Schema.optional(Schema.String),
  claudeMode: Schema.optional(Schema.Boolean),
  antigravityMode: Schema.optional(Schema.Boolean),
  codexMode: Schema.optional(Schema.Boolean),
  piMode: Schema.optional(Schema.Boolean),
  claudeAgentsMode: Schema.optional(Schema.Boolean),
  resumeSessionId: Schema.optional(Schema.String),
  claudeSessionId: Schema.optional(Schema.String),
  piSessionId: Schema.optional(Schema.String),
  launchProfileId: Schema.optional(Schema.String),
  piProvider: Schema.optional(Schema.String),
  /** A level as Pi spells it (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). */
  piThinking: Schema.optional(Schema.String),
  initialCommand: Schema.optional(Schema.String),
  autoExecute: Schema.optional(Schema.Boolean),
  initialPrompt: Schema.optional(Schema.String),
  tmuxMode: Schema.optional(Schema.Boolean),
  adoptTmuxName: Schema.optional(Schema.String),
  adoptSessionId: Schema.optional(Schema.String),
  configDir: Schema.optional(Schema.String),
  claudeProfileId: Schema.optional(Schema.String),
  claudeProfileLabel: Schema.optional(Schema.String),
  codexAccountId: Schema.optional(Schema.String),
  codexAccountLabel: Schema.optional(Schema.String),
  workspaceId: Schema.optional(Schema.String),
  link: Schema.optional(SessionLink)
})
export type SpawnOptions = typeof SpawnOptions.Type

/** What a started session answers with: the shell's `SessionInfo`, the
 *  record a sidebar tab is made from. */
export const SessionInfo = Schema.Struct({
  id: Schema.NonEmptyString,
  cwd: Schema.String,
  folderName: Schema.String,
  alive: Schema.Boolean,
  claudeSessionId: Schema.NullOr(Schema.String),
  piSessionId: Schema.NullOr(Schema.String),
  launchProfileId: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  piProvider: Schema.optional(Schema.String),
  piThinking: Schema.optional(Schema.String)
})
export type SessionInfo = typeof SessionInfo.Type

// ── Failures ──

/** No session carries that id on this server. */
export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()('SessionNotFound', {
  id: Schema.String
}) {}

/** The session's provider refused the write, or the shell could not prepare
 *  it (a file an attachment names is gone): the message is the provider's or
 *  the shell's own, and the composer keeps its draft. */
export class SessionWriteRefused extends Schema.TaggedError<SessionWriteRefused>()(
  'SessionWriteRefused',
  { id: Schema.String, message: Schema.String }
) {}

/** The shell could not stop the session: what the kill threw, in its words. */
export class SessionStopFailed extends Schema.TaggedError<SessionStopFailed>()(
  'SessionStopFailed',
  { id: Schema.String, message: Schema.String }
) {}

/** The shell could not start the session: a path that is not there, a
 *  provider that refused, an adapter that is disabled. */
export class SessionStartFailed extends Schema.TaggedError<SessionStartFailed>()(
  'SessionStartFailed',
  { message: Schema.String }
) {}

// ── Commands and queries ──

/** The sessions the server knows, every one or those of one window. A server
 *  that runs no sessions says so rather than answering an empty list a window
 *  would take for "none open". */
export const ListSessions = Query.define('ListSessions', {
  payload: Schema.Struct({ windowKey: Schema.optional(Schema.String) }),
  success: Schema.Array(Session),
  failure: CapabilityUnavailable
})
/** One session by id. */
export const GetSession = Query.define('GetSession', {
  payload: Schema.Struct({ id: Schema.String }),
  success: Session,
  failure: SessionNotFound
})
/**
 * Start a session in `cwd` for the window named by `windowKey` (the asking
 * window is the session's home; a windowless caller passes none and the
 * shell falls back as it does for an agent's launch). A server with no
 * terminal process answers `CapabilityUnavailable`.
 */
export const StartSession = Command.define('StartSession', {
  payload: Schema.Struct({
    cwd: Schema.String,
    windowKey: Schema.optional(Schema.String),
    options: Schema.optional(SpawnOptions)
  }),
  success: SessionInfo,
  failure: Schema.Union(CapabilityUnavailable, SessionStartFailed)
})
/** Stop a session: its process ended, its record released. Idempotent on a
 *  session already gone, as the shell's own kill is. */
export const StopSession = Command.define('StopSession', {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Void,
  failure: Schema.Union(CapabilityUnavailable, SessionStopFailed)
})
/** Hand a session what a view wrote: a typed input or terminal bytes. A
 *  user message's attachments are prepared by the shell at the write, from
 *  the files they name. */
export const WriteSession = Command.define('WriteSession', {
  payload: Schema.Struct({ id: Schema.String, input: SessionWrite }),
  success: Schema.Void,
  failure: Schema.Union(SessionNotFound, SessionWriteRefused)
})
/** The view a session is read in, `<pluginId>/<viewId>`; null hands it back
 *  to the host's default. Answers the record as it stands. */
export const SetSessionView = Command.define('SetSessionView', {
  payload: Schema.Struct({ id: Schema.String, viewId: Schema.NullOr(Schema.NonEmptyString) }),
  success: Session,
  failure: Schema.Union(SessionNotFound, SessionWriteRefused)
})
/** The models the session may switch to; empty when its provider offers none. */
export const GetSessionModels = Query.define('GetSessionModels', {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Array(ModelOption),
  failure: SessionNotFound
})
/** The commands the composer offers under "/"; empty when the provider has none. */
export const GetSessionCommands = Query.define('GetSessionCommands', {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Array(CommandOption),
  failure: SessionNotFound
})
/** What the session's adapter takes beyond text. */
export const SessionCapabilities = Schema.Struct({ images: Schema.Boolean })
export type SessionCapabilities = typeof SessionCapabilities.Type
export const GetSessionCapabilities = Query.define('GetSessionCapabilities', {
  payload: Schema.Struct({ id: Schema.String }),
  success: SessionCapabilities,
  failure: SessionNotFound
})
/** A page of a resumed conversation's past, newest first, ending at `before`
 *  (its end when absent), about `limit` events long. A GET carries its
 *  numbers as strings, so they are decoded from strings here. */
export const GetSessionHistory = Query.define('GetSessionHistory', {
  payload: Schema.Struct({
    id: Schema.String,
    before: Schema.optional(Schema.NumberFromString.pipe(Schema.nonNegative(), Schema.int())),
    limit: Schema.optional(Schema.NumberFromString.pipe(Schema.nonNegative(), Schema.int()))
  }),
  success: HistoryPage,
  failure: SessionNotFound
})
