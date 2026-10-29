/**
 * The shapes of the wire the phone speaks, mirrored from `@clave/contract`
 * as plain TypeScript. The contract itself cannot be bundled for the phone:
 * every module of it imports `@structure-ai/cqrs`, which imports
 * `@structure-ai/observability`, which reaches `@effect/opentelemetry` and
 * `@effect/platform`; `requests`, `push` and `events` also import the
 * `@structure-ai/http` barrel with its `node:*` modules and the Bun runtime
 * (the probe is written in docs/mobile.md). So the phone keeps this mirror,
 * and `contract-pin.test.ts` beside it decodes the same samples through the
 * contract's own schemas and through `decode.ts`, under Node, and fails on
 * a drift. One file per contract module is not needed: the phone speaks a
 * dozen shapes, listed here in the contract's order.
 *
 * Mirrors, by module: `sessions.ts` (Session, SessionEvent, SessionStream,
 * HistoryPage, SpawnOptions, SessionInfo, the failures), `requests.ts`
 * (PendingRequest, RequestSnapshot, RequestResponse), `settings/
 * launch-profiles.ts` (LaunchProfileView, LaunchProfilePreferencesView),
 * `settings/workspaces.ts` (WorkspaceView, WorkspaceStateView), `files.ts`
 * (FileText), `push.ts` (the frames), `events.ts` (the envelope and the
 * events the phone reads), `errors.ts` (CapabilityUnavailable).
 */

// ── sessions.ts ──

export type AgentState = 'idle' | 'working' | 'blocked' | 'done' | 'ended'
export type Transport = 'pty' | 'events'

export interface Session {
  readonly id: string
  readonly provider: string
  readonly transport: Transport
  readonly cwd: string
  readonly windowKey: string
  readonly groupId?: string
  readonly state: AgentState
  readonly createdAt: number
  readonly adapterId: string
  readonly title: string
  readonly viewId?: string
}

export interface FileAttachment {
  readonly id: string
  readonly label?: string
  readonly path: string
  readonly name: string
  readonly mimeType: string
  readonly size: number
  readonly delivery: 'reference' | 'image' | 'folder'
  readonly entries?: number
}
export interface SessionAttachment {
  readonly id: string
  readonly label?: string
  readonly delivery: 'session'
  readonly sessionId: string
  readonly name: string
  readonly agent: string
  readonly cwd: string
}
export type Attachment = FileAttachment | SessionAttachment

export interface UserMessage {
  readonly type: 'user_message'
  readonly clientMessageId?: string
  readonly text: string
  readonly attachments?: readonly Attachment[]
}
export interface PermissionResponse {
  readonly type: 'permission_response'
  readonly id: string
  readonly optionId: string
  readonly answers?: Readonly<Record<string, string>>
}
export interface Interrupt {
  readonly type: 'interrupt'
}
/** What the phone writes to a session: a message (with the id the phone
 *  minted, which lane B makes the server honour; a server before that drops
 *  the field, a struct ignoring what it does not declare), an answer to a
 *  prompt, or an interrupt. */
export type SessionWriteInput =
  | (UserMessage & { readonly clientMessageId?: string })
  | PermissionResponse
  | Interrupt

export interface PermissionModeOption {
  readonly id: string
  readonly label: string
}
export interface AgentQuestionOption {
  readonly label: string
  readonly description?: string
}
export interface AgentQuestion {
  readonly id?: string
  readonly question: string
  readonly header?: string
  readonly options: readonly AgentQuestionOption[]
  readonly multiSelect?: boolean
}
export interface BackgroundTask {
  readonly id: string
  readonly kind: 'shell' | 'agent' | 'other'
  readonly description: string
  readonly toolUseId?: string
  readonly startedAt: number
  readonly outputFile?: string
  readonly model?: string
}

export interface PermissionRequestEvent {
  readonly type: 'permission_request'
  readonly id: string
  readonly description: string
  readonly options: readonly { readonly id: string; readonly label: string }[]
  readonly toolName?: string
  readonly input?: unknown
  readonly detail?: string
  readonly questions?: readonly AgentQuestion[]
}

export type SessionEvent =
  | UserMessage
  | { readonly type: 'assistant_text'; readonly delta: string; readonly final: boolean }
  | {
      readonly type: 'tool_call'
      readonly id: string
      readonly name: string
      readonly input: unknown
      readonly parent?: string
    }
  | {
      readonly type: 'tool_result'
      readonly id: string
      readonly output: unknown
      readonly error?: boolean
    }
  | PermissionRequestEvent
  | { readonly type: 'state_change'; readonly state: AgentState }
  | {
      readonly type: 'session_meta'
      readonly model: string | null
      readonly providerSessionId: string | null
    }
  | { readonly type: 'effort'; readonly effort: string | null }
  | { readonly type: 'error'; readonly message: string; readonly fatal: boolean }
  | { readonly type: 'turn_interrupted' }
  | {
      readonly type: 'context_usage'
      readonly used: number
      readonly window: number | null
      readonly parent?: string
    }
  | { readonly type: 'subagent_model'; readonly parent: string; readonly model: string }
  | {
      readonly type: 'permission_mode'
      readonly mode: string
      readonly modes: readonly PermissionModeOption[]
    }
  | { readonly type: 'background_tasks'; readonly tasks: readonly BackgroundTask[] }
  | { readonly type: 'provider_event'; readonly provider: string; readonly payload: unknown }

/** One frame of a session's stream as the wire carries it: terminal bytes
 *  stay base64 on the phone, which shows no terminal. */
export type SessionStream =
  | { readonly kind: 'pty'; readonly data: string }
  | { readonly kind: 'event'; readonly event: SessionEvent }

export interface HistoryItem {
  readonly event: SessionEvent
  readonly at?: number
}
export interface HistoryPage {
  readonly items: readonly HistoryItem[]
  readonly before: number | null
}

export type LauncherFamily = 'claude' | 'antigravity' | 'codex' | 'pi'
export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The status of a write by the id the phone minted (the seam of 29 October
 *  2026, `GET /sessions/writes?id=&clientMessageId=`, lane B's route): what
 *  the server knows of a send whose outcome the phone did not see. */
export type WriteStatusKind = 'accepted' | 'pending' | 'rejected' | 'absent' | 'unknown'
export interface WriteStatus {
  readonly status: WriteStatusKind
  readonly at?: number
  readonly reason?: string
}

// ── settings/launch-profiles.ts ──

export interface LaunchProfileView {
  readonly id: string
  readonly name: string
  readonly family: LauncherFamily
  readonly command: readonly string[]
  readonly additionalArgs: readonly string[]
  readonly builtIn?: boolean
  readonly sourceProfileId?: string
  readonly pi?: {
    readonly provider?: string
    readonly model?: string
    readonly thinking?: PiThinkingLevel
  }
}
export type FamilyDefaultsView = Partial<Record<LauncherFamily, string>>
export interface LaunchProfilePreferencesView {
  readonly version: 1
  readonly customProfiles: readonly LaunchProfileView[]
  readonly globalDefaults: FamilyDefaultsView
  readonly workspaceOverrides: Readonly<Record<string, FamilyDefaultsView>>
}

/** What the phone sends to start a session: the family boolean, the profile
 *  by id and its full definition (the seam `wireOptions` uses on the Mac),
 *  the workspace the record is stamped with. */
export interface SpawnOptions {
  readonly claudeMode?: boolean
  readonly antigravityMode?: boolean
  readonly codexMode?: boolean
  readonly piMode?: boolean
  readonly launchProfileId?: string
  readonly launchProfile?: LaunchProfileView
  readonly workspaceId?: string
}
export interface StartSessionInput {
  readonly cwd: string
  readonly windowKey?: string
  readonly options?: SpawnOptions
}
export interface SessionInfo {
  readonly id: string
  readonly cwd: string
  readonly folderName: string
  readonly alive: boolean
  readonly claudeSessionId: string | null
  readonly piSessionId: string | null
  readonly launchProfileId?: string
  readonly model?: string
  readonly piProvider?: string
  readonly piThinking?: string
}
export interface SessionCapabilities {
  readonly images: boolean
}
/** The part of a session's record the phone reads: which workspace it is
 *  stamped with (a live Session carries none). */
export interface SessionRecord {
  readonly id: string
  readonly cwd: string
  readonly folderName: string
  readonly workspaceId?: string
  readonly displayName?: string
  readonly launchProfileId?: string
  readonly live?: boolean
  readonly running?: boolean
}

// ── settings/workspaces.ts ──

export interface WorkspaceView {
  readonly id: string
  readonly name: string
  readonly rootDir: string
  readonly profileFile: string | null
  readonly createdAt: number
}
export interface WorkspaceStateView {
  readonly version: 1
  readonly workspaces: readonly WorkspaceView[]
  readonly lastActiveWorkspaceId: string | null
  readonly activeWorkspaceId: string | null
  readonly pins: readonly unknown[]
  readonly pinsMigrated: boolean
  readonly revision: number
  readonly instance: string
}

// ── requests.ts ──

export type SecretAction =
  | {
      readonly type: 'run'
      readonly command: string
      readonly cwd: string
      readonly envVar: string
    }
  | { readonly type: 'env-file'; readonly file: string; readonly key: string }
export type RequestKind = 'permission' | 'clarification' | 'secret'
export interface PendingRequest {
  readonly id: string
  readonly sessionId: string
  readonly kind: RequestKind
  readonly description: string
  readonly createdAt: number
  readonly providerRequestId?: string
  readonly options?: readonly { readonly id: string; readonly label: string }[]
  readonly questions?: readonly AgentQuestion[]
  readonly secretQuestions?: readonly string[]
  readonly toolName?: string
  readonly detail?: string
  readonly input?: unknown
  readonly action?: SecretAction
}
export interface RequestSnapshot {
  readonly revision: number
  readonly pending: readonly PendingRequest[]
}
export type RequestResponse =
  | {
      readonly type: 'permission'
      readonly optionId: string
      readonly answers?: Readonly<Record<string, string>>
    }
  | { readonly type: 'clarification'; readonly answers: Readonly<Record<string, string>> }
  | { readonly type: 'secret'; readonly value: string }
  | { readonly type: 'dismiss' }
export interface ResolveRequestInput {
  readonly requestId: string
  readonly response: RequestResponse
}
export interface ResolveOutcome {
  readonly accepted: boolean
}

// ── files.ts ──

export interface FileLocation {
  readonly root: string
  readonly path: string
}
export interface FileText {
  readonly content: string
  readonly truncated: boolean
  readonly size: number
  readonly binary: boolean
}

// ── errors.ts and the domains' failures, as a 422 carries them ──

/** A refusal the server declared: the tag names the failure, the message is
 *  the sentence to show. `capability` is set on `CapabilityUnavailable`. */
export interface ServerFailure {
  readonly _tag: string
  readonly message: string
  readonly capability?: string
  readonly code?: string
  readonly id?: string
}

// ── events.ts ──

export type ServerEvent =
  | { readonly _tag: 'requests.changed'; readonly revision: number }
  | { readonly _tag: 'session.state_changed'; readonly id: string; readonly state: AgentState }
  | { readonly _tag: 'session.title_changed'; readonly id: string; readonly title: string }
  | { readonly _tag: 'session.renamed'; readonly id: string; readonly name: string }
  | {
      readonly _tag: 'workspaces.state_changed'
      readonly workspaces: readonly WorkspaceView[]
      readonly revision: number
      readonly instance: string
    }
  /** Every other member of the server's union: carried by its tag, read by nobody here. */
  | { readonly _tag: 'unknown'; readonly tag: string }
export interface ServerEventEnvelope {
  readonly id: string
  readonly seq: number
  readonly at: number
  readonly event: ServerEvent
}

// ── push.ts ──

export const PUSH_PATH = '/push'
export const PUSH_PROTOCOL = 1
export const HELLO_TIMEOUT_MS = 5_000
export const CLOSE_UNAUTHORIZED = 4001
export const CLOSE_MALFORMED = 4002
export const CLOSE_HELLO_TIMEOUT = 4008
export const CLOSE_SERVER_STOPPING = 4010

export type ClientFrame =
  | { readonly _tag: 'hello'; readonly token: string; readonly client?: string }
  | { readonly _tag: 'subscribe'; readonly sessionId: string }
  | { readonly _tag: 'unsubscribe'; readonly sessionId: string }
  | { readonly _tag: 'ping' }

export type ServerFrame =
  | {
      readonly _tag: 'welcome'
      readonly serverId: string
      readonly protocol: 1
      readonly version?: string
    }
  | { readonly _tag: 'subscribed'; readonly sessionId: string; readonly session: Session }
  | { readonly _tag: 'unsubscribed'; readonly sessionId: string }
  | { readonly _tag: 'stream'; readonly sessionId: string; readonly stream: SessionStream }
  | { readonly _tag: 'exit'; readonly sessionId: string; readonly code: number }
  | ({ readonly _tag: 'event' } & ServerEventEnvelope)
  | { readonly _tag: 'error'; readonly sessionId?: string; readonly message: string }
  | { readonly _tag: 'pong' }
  /** The desktop view requests and any frame a later server adds: ignored. */
  | { readonly _tag: 'request' }

/** POST /sessions/write acknowledgement. A pending duplicate has not landed yet. */
export interface WriteAnswer {
  readonly status: 'accepted' | 'pending'
  readonly at?: number
}
