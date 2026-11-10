/**
 * The intermediate representation: one conversation, provider-neutral.
 *
 * A model's working context is the whole tape, not the prose: what the person
 * said, what the agent answered, every tool it called and what each call
 * returned. The readers turn a provider's own storage into this shape and
 * the writers lay it down in another provider's storage, so a conversation
 * started on one CLI resumes natively on another. The events are the ones
 * Clave's session model speaks (`src/shared/session-model.ts`, `HistoryItem`),
 * copied here field by field so the package stands alone.
 */

/** What the person typed. */
export interface UserMessage {
  type: 'user_message'
  /** The message as written, provider wrappers (slash-command markup, injected
   *  context, interruption notices) already stripped by the reader. */
  text: string
  /** A hosted form's outcome the host wrote as the person's message (Clave's
   *  `clave_request_input`): the form's provider id, read off the text's own
   *  marker. A writer keeps the text; the marker rides inside it. */
  form?: string
  /** The tool call that started the subagent this message briefed, when it is
   *  a subagent's own and not the conversation's. */
  parent?: string
}

/** What the agent said, final text only (a transcript holds no deltas). */
export interface AssistantText {
  type: 'assistant_text'
  delta: string
  /** Always true from a reader: a replayed message is whole. */
  final: boolean
  parent?: string
}

/** A tool the agent called. */
export interface ToolCall {
  type: 'tool_call'
  /** The provider's own call id; the matching `tool_result` carries the same. */
  id: string
  /** The tool's name in the source provider's vocabulary (Claude's `Bash`,
   *  `Edit`, `mcp__server__tool`; Codex's `commandExecution`, `fileChange`,
   *  `server/tool`, or a function's name). A writer maps it. */
  name: string
  /** The call's arguments as the provider recorded them (parsed JSON when
   *  the provider stored JSON text). */
  input: unknown
  parent?: string
}

/** What a tool call returned. */
export interface ToolResult {
  type: 'tool_result'
  id: string
  /** The output as recorded: a string, content blocks, or `undefined` when the
   *  transcript never answered the call (the reader closes it so). */
  output: unknown
  /** The provider's word that the call FAILED; absent means not known to have
   *  failed, never "succeeded". */
  error?: boolean
  parent?: string
}

/** The provider's own identity for the session, as its storage names it. */
export interface SessionMeta {
  type: 'session_meta'
  model: string | null
  providerSessionId: string | null
}

/** How full the context was after a call: tokens read and written, and the
 *  model's window when known. */
export interface ContextUsage {
  type: 'context_usage'
  used: number
  window: number | null
  /** The model id the frame that carried this usage named, when it did: a
   *  consumer that knows a model's window by name (Clave's table) reads it
   *  where the reader itself leaves `window` null. */
  model?: string
  parent?: string
}

/** The person cut a turn short. */
export interface TurnInterrupted {
  type: 'turn_interrupted'
}

export type SessionEvent =
  | UserMessage
  | AssistantText
  | ToolCall
  | ToolResult
  | SessionMeta
  | ContextUsage
  | TurnInterrupted

/** One event of the conversation's past, with the moment the storage says it
 *  happened (epoch milliseconds) when it says one. */
export interface HistoryItem {
  event: SessionEvent
  at?: number
}

export type Provider = 'claude' | 'codex'

/** What a session is, apart from its tape. */
export interface SessionHead {
  /** Which CLI wrote the source. */
  provider: Provider
  /** The provider's own session id (Claude's conversation UUID, Codex's thread id). */
  id: string
  /** The model the source names last, in the provider's own id; null when it
   *  never says. */
  model: string | null
  /** The working directory the conversation ran in. */
  cwd: string
  /** The CLI version that wrote the source, when it says. */
  cliVersion: string | null
  /** First and last timestamps of the tape, epoch milliseconds; null on an
   *  undated source. */
  startedAt: number | null
  endedAt: number | null
  /** Where the source was read from (a file path). */
  source: string
}

export interface Session {
  head: SessionHead
  items: HistoryItem[]
}

/** The reader met a file it does not recognise as the provider's storage. */
export class UnrecognisedTranscriptError extends Error {
  readonly provider: Provider
  readonly path: string
  constructor(provider: Provider, path: string, detail: string) {
    super(`Not a ${provider} transcript the reader recognises: ${path} (${detail})`)
    this.name = 'UnrecognisedTranscriptError'
    this.provider = provider
    this.path = path
  }
}

/** A plain object, else `{}`: the readers walk untrusted JSON. */
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
export const text = (value: unknown): string => (typeof value === 'string' ? value : '')
