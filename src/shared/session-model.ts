import { z } from 'zod'
import { AttachmentsSchema, ProviderImageSchema } from './attachments'

export const AgentStateSchema = z.enum(['idle', 'working', 'blocked', 'done', 'ended'])
export type AgentState = z.infer<typeof AgentStateSchema>
export const TransportSchema = z.enum(['pty', 'events'])
export type Transport = z.infer<typeof TransportSchema>

export const SessionSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  transport: TransportSchema,
  cwd: z.string(),
  windowKey: z.string(),
  groupId: z.string().optional(),
  state: AgentStateSchema,
  createdAt: z.number(),
  adapterId: z.string().min(1),
  title: z.string(),
  /** The view this session is read in, `<pluginId>/<viewId>`, as the pane's
   *  picker set it or the launch profile named it. Absent means the host
   *  picks the first view that renders this transport. */
  viewId: z.string().min(1).optional()
})
export type Session = z.infer<typeof SessionSchema>

export const UserMessageSchema = z.object({
  type: z.literal('user_message'),
  text: z.string(),
  /** The files the reader attached, as the transcript shows them: names,
   *  paths and how each was delivered — never their bytes. */
  attachments: AttachmentsSchema.optional()
})
export type UserMessage = z.infer<typeof UserMessageSchema>
/** What the provider is handed once main has prepared the attachments: the
 *  text with the file references appended, and the images as base64. Main's
 *  own — the session IPC discards whatever a renderer puts here and prepares
 *  from the attachments itself, so a renderer cannot send a byte it did not
 *  first attach by path. Absent, the provider gets the text as written. */
export const PreparedPromptSchema = z.object({
  text: z.string(),
  images: z.array(ProviderImageSchema)
})
export type PreparedPrompt = z.infer<typeof PreparedPromptSchema>
export const UserMessageInputSchema = UserMessageSchema.extend({
  prepared: PreparedPromptSchema.optional()
})
export type UserMessageInput = z.infer<typeof UserMessageInputSchema>
/** The event a user message becomes on the stream: the message as written,
 *  without the prepared prompt — the transcript shows what the reader said and
 *  attached, and base64 image payloads have no place in a renderer's log. */
export function userMessageEvent(input: UserMessageInput): UserMessage {
  return {
    type: 'user_message',
    text: input.text,
    ...(input.attachments?.length ? { attachments: input.attachments } : {})
  }
}
/** What the provider receives for a user message: the prepared prompt when
 *  main built one, else the text as written. */
export function providerPrompt(input: UserMessageInput): PreparedPrompt {
  return input.prepared ?? { text: input.text, images: [] }
}
export const PermissionResponseSchema = z.object({
  type: z.literal('permission_response'),
  id: z.string(),
  optionId: z.string(),
  /** A request carrying `questions`: question text → the chosen label(s),
   *  several joined by ", ", or the reader's own words. */
  answers: z.record(z.string(), z.string()).optional()
})
export const InterruptSchema = z.object({ type: z.literal('interrupt') })
/** Switch the session's model; null asks the provider for its own default. */
export const SetModelSchema = z.object({
  type: z.literal('set_model'),
  model: z.string().nullable()
})
export type SetModel = z.infer<typeof SetModelSchema>
/** One question an agent asks the reader mid-turn (Claude's AskUserQuestion). */
export const AgentQuestionSchema = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean().optional()
})
export type AgentQuestion = z.infer<typeof AgentQuestionSchema>
export const SessionInputSchema = z.discriminatedUnion('type', [
  UserMessageInputSchema,
  PermissionResponseSchema,
  InterruptSchema,
  SetModelSchema
])
/** One model a provider offers a live session, as the view lists it. */
export const ModelOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  hint: z.string().optional(),
  /** The full model id an alias stands for today (Claude's "opus" →
   *  "claude-opus-5-5"), so a session reporting the full id finds its option. */
  resolved: z.string().optional()
})
export type ModelOption = z.infer<typeof ModelOptionSchema>
/** One command the composer can offer under "/": the provider says what it is
 *  called, what it does, and the exact text that invokes it (Claude's "/name",
 *  Codex's "$name" skill mention). */
export const CommandOptionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  insert: z.string()
})
export type CommandOption = z.infer<typeof CommandOptionSchema>
export type SessionInput = z.infer<typeof SessionInputSchema>
/** One piece of work the agent left running past its turn: a background shell,
 *  a background subagent. The turn can be `done` while these still run. */
export const BackgroundTaskSchema = z.object({
  id: z.string(),
  kind: z.enum(['shell', 'agent', 'other']),
  description: z.string(),
  /** The tool call that started it, when the provider says. */
  toolUseId: z.string().optional(),
  /** When this host first heard of it (epoch ms), for the elapsed timer. */
  startedAt: z.number(),
  /** Where the provider writes its output, when it says. */
  outputFile: z.string().optional()
})
export type BackgroundTask = z.infer<typeof BackgroundTaskSchema>
export const SessionEventSchema = z.discriminatedUnion('type', [
  UserMessageSchema,
  z.object({ type: z.literal('assistant_text'), delta: z.string(), final: z.boolean() }),
  z.object({ type: z.literal('tool_call'), id: z.string(), name: z.string(), input: z.unknown() }),
  /* `error` is the adapter's word that the tool FAILED, never the view's guess.
     Optional because an adapter that cannot tell says nothing, and an absent
     flag means "not known to have failed" rather than "succeeded". */
  z.object({
    type: z.literal('tool_result'),
    id: z.string(),
    output: z.unknown(),
    error: z.boolean().optional()
  }),
  z.object({
    type: z.literal('permission_request'),
    id: z.string(),
    description: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string() })),
    toolName: z.string().optional(),
    input: z.unknown().optional(),
    /** Why the agent needs the approval, in the provider's own words. */
    detail: z.string().optional(),
    /** Present when the request is questions to answer rather than a tool to
     *  allow; the reply is a permission_response carrying `answers`. */
    questions: z.array(AgentQuestionSchema).optional()
  }),
  z.object({ type: z.literal('state_change'), state: AgentStateSchema }),
  z.object({
    type: z.literal('session_meta'),
    model: z.string().nullable(),
    providerSessionId: z.string().nullable()
  }),
  z.object({ type: z.literal('error'), message: z.string(), fatal: z.boolean() }),
  /* The turn the reader's `interrupt` stopped ended there: the provider's word
     that it was cut short, never a failure. A view mutes the message that
     started it rather than raising an error card over it. */
  z.object({ type: z.literal('turn_interrupted') }),
  /* Everything still running in the background, whole, each time it changes:
     a snapshot replaces the last one, and an empty list means nothing is. */
  z.object({ type: z.literal('background_tasks'), tasks: z.array(BackgroundTaskSchema) }),
  z.object({ type: z.literal('provider_event'), provider: z.string(), payload: z.unknown() })
])
export type SessionEvent = z.infer<typeof SessionEventSchema>
/** One event of a conversation's past, with the moment the transcript says it
 *  happened when it says one. A resumed session keeps its past in main and a
 *  view reads it a page at a time (`sessions:history`), newest first, rather
 *  than taking the whole of it down the stream before the first paint. */
export interface HistoryItem {
  event: SessionEvent
  at?: number
}
/** A page of that past, oldest first. `before` is what to ask for the page
 *  older than this one, and null once there is nothing older. */
export interface HistoryPage {
  items: HistoryItem[]
  before: number | null
}
export const SessionStreamSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pty'), data: z.instanceof(Uint8Array) }),
  z.object({ kind: z.literal('event'), event: SessionEventSchema })
])
export type SessionStream = z.infer<typeof SessionStreamSchema>
