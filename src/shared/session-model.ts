import { z } from 'zod'
import { INPUT_KINDS } from '@clave/contract/input-kinds'
import { AttachmentsSchema, ProviderImageSchema } from './attachments'
import { isValidEffort } from './effort'

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
  viewId: z.string().min(1).optional(),
  /** Which process under this id this is (1 at the first spawn, one more at
   *  every spawn under the same id since the host started); a `state_change`
   *  carries the run it belongs to (PRDCT-4191). Absent on a stopped record. */
  run: z.number().optional()
})
export type Session = z.infer<typeof SessionSchema>

export const UserMessageSchema = z.object({
  type: z.literal('user_message'),
  text: z.string(),
  /** The files the reader attached, as the transcript shows them: names,
   *  paths and how each was delivered — never their bytes. */
  attachments: AttachmentsSchema.optional(),
  /** A subagent's brief (the prompt its call gave it), named by that call:
   *  the first line of the subagent's own transcript, never the reader's. */
  parent: z.string().optional(),
  /** The form this message carries the answers of (the request's provider
   *  id, PRDCT-4157): the person's Approve or Skip on a hosted form, written
   *  to the agent as their next message. The transcript draws the form's
   *  record row for it, never a bubble. */
  form: z.string().optional()
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
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.form ? { form: input.form } : {})
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
  /** A request carrying `questions`: the question's key → the chosen label(s)
   *  or the reader's own words; a hosted multi-select answers with the labels
   *  as an array, a provider's own question with one string (several joined
   *  by ", "). */
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional()
})
/** What the person typed into a form still open (PRDCT-4210): the form's
 *  draft takes it; it never reaches a provider (packages/contract mirrors). */
export const PermissionDraftSchema = z.object({
  type: z.literal('permission_draft'),
  id: z.string(),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())]))
})
/** The answers as a provider's wire takes them: one string per question, a
 *  hosted multi-select's labels joined by ", ". The adapters call this at
 *  their boundary; a hosted request's answers never reach a provider. */
export function flattenAnswers(
  answers: Readonly<Record<string, string | readonly string[]>> | undefined
): Record<string, string> | undefined {
  if (!answers) return undefined
  return Object.fromEntries(
    Object.entries(answers).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : value.join(', ')
    ])
  )
}
export const InterruptSchema = z.object({ type: z.literal('interrupt') })
/** Switch the session's model; null asks the provider for its own default. */
export const SetModelSchema = z.object({
  type: z.literal('set_model'),
  model: z.string().nullable(),
  /** Whether the pick becomes the next chat's default (the composer's pick
   *  does; a move the policy makes at a cap does not, PRDCT-4302). Absent
   *  means yes. */
  remember: z.boolean().optional()
})
export type SetModel = z.infer<typeof SetModelSchema>
/** Switch how hard the session's model thinks: one of the levels its
 *  `ModelOption.efforts` lists, in the provider's own word. */
export const SetEffortSchema = z.object({
  type: z.literal('set_effort'),
  effort: z.string().refine(isValidEffort, 'Invalid reasoning effort')
})
export type SetEffort = z.infer<typeof SetEffortSchema>
/** Switch how the agent asks before it acts (Claude's Shift+Tab cycle): one of
 *  the ids the session's last `permission_mode` event offered. */
export const SetPermissionModeSchema = z.object({
  type: z.literal('set_permission_mode'),
  mode: z.string()
})
/** Stop one piece of background work (a background subagent, a background
 *  shell) by the id its `background_tasks` entry carries; the turn goes on. */
export const StopTaskSchema = z.object({
  type: z.literal('stop_task'),
  taskId: z.string().min(1)
})
/** One permission mode a session can be switched to, in the provider's own
 *  vocabulary (`id`) and as the reader reads it (`label`). */
export const PermissionModeOptionSchema = z.object({ id: z.string(), label: z.string() })
export type PermissionModeOption = z.infer<typeof PermissionModeOptionSchema>
/** One question an agent asks the reader mid-turn (Claude's AskUserQuestion). */
export const AgentQuestionSchema = z.object({
  /** Stable answer key; older providers without IDs use the question text. */
  id: z.string().min(1).optional(),
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean().optional(),
  /** A hosted input request's question (clave_request_input, PRDCT-4157):
   *  the kind of value asked for and the field's own words; absent on a
   *  provider's native question. Mirrors `packages/contract/src/sessions.ts`;
   *  the one rule for whether an answer fits is the contract's `input-kinds.ts`. */
  kind: z.enum(INPUT_KINDS).optional(),
  hint: z.string().optional(),
  placeholder: z.string().optional(),
  default: z.string().optional(),
  optional: z.boolean().optional(),
  url: z.string().optional(),
  confirm: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional()
})
export type AgentQuestion = z.infer<typeof AgentQuestionSchema>
export const SessionInputSchema = z.discriminatedUnion('type', [
  UserMessageInputSchema,
  PermissionResponseSchema,
  PermissionDraftSchema,
  InterruptSchema,
  SetModelSchema,
  SetEffortSchema,
  SetPermissionModeSchema,
  StopTaskSchema
])
/** One reasoning effort a model can run at: the provider's word (`id`), how
 *  it reads (`label`), and the provider's gloss when it gives one. */
export const EffortOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  hint: z.string().optional()
})
export type EffortOption = z.infer<typeof EffortOptionSchema>
/** One model a provider offers a live session, as the view lists it. */
export const ModelOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  hint: z.string().optional(),
  /** The full model id an alias stands for today (Claude's "opus" →
   *  "claude-opus-5-5"), so a session reporting the full id finds its option. */
  resolved: z.string().optional(),
  /** The reasoning efforts this model takes, lowest first. Absent or empty:
   *  the model takes none, and a view offers no choice. */
  efforts: z.array(EffortOptionSchema).optional(),
  /** The level the provider runs this model at when nobody chose one. */
  defaultEffort: z.string().optional()
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
/** One control request a view may send a live session's provider: read the
 *  MCP servers, turn one on or off, reconnect it, start or clear its sign-in,
 *  reload the plugins. The set is closed on purpose: the provider's control
 *  channel also changes the permission mode and the like, and none of that
 *  may pass here. The answer is the provider's own, as it gave it. */
export const SessionControlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mcp_status') }),
  z.object({ type: z.literal('mcp_toggle'), server: z.string().min(1), enabled: z.boolean() }),
  z.object({ type: z.literal('mcp_reconnect'), server: z.string().min(1) }),
  z.object({ type: z.literal('mcp_authenticate'), server: z.string().min(1) }),
  z.object({ type: z.literal('mcp_clear_auth'), server: z.string().min(1) }),
  z.object({ type: z.literal('reload_plugins') })
])
export type SessionControl = z.infer<typeof SessionControlSchema>
export const SessionControlResultSchema = z.record(z.string(), z.unknown())
export type SessionControlResult = z.infer<typeof SessionControlResultSchema>
export type SessionInput = z.infer<typeof SessionInputSchema>
/** One piece of work the agent left running past its turn: a background shell,
 *  a background subagent. The turn can be `done` while these still run. */
export const BackgroundTaskSchema = z.object({
  id: z.string(),
  kind: z.enum(['shell', 'agent', 'other']),
  /** What a row says: an agent's task, or a shell's title (the call's own
   *  description, else the command shortened). */
  description: z.string(),
  /** A shell's full command line, when known, for a tooltip. */
  command: z.string().optional(),
  /** The tool call that started it, when the provider says. */
  toolUseId: z.string().optional(),
  /** When this host first heard of it (epoch ms), for the elapsed timer. */
  startedAt: z.number(),
  /** Where the provider writes its output, when it says. */
  outputFile: z.string().optional(),
  /** The model a background agent runs on, when the provider names it at the
   *  start (Codex resolves it then); held on the task so a view that binds
   *  late still reads it off the snapshot. */
  model: z.string().optional()
})
export type BackgroundTask = z.infer<typeof BackgroundTaskSchema>
export const SessionEventSchema = z.discriminatedUnion('type', [
  UserMessageSchema,
  /* `parent` on a message, a text, a call or a result names the call that
     started the subagent speaking or acting: the event is that subagent's
     own, for a view of it, and never the conversation's transcript. */
  z.object({
    type: z.literal('assistant_text'),
    delta: z.string(),
    final: z.boolean(),
    parent: z.string().optional()
  }),
  z.object({
    type: z.literal('tool_call'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
    /** The call that started the subagent making this one, when a subagent
     *  made it (Claude's `parent_tool_use_id`); absent on the main thread. */
    parent: z.string().optional()
  }),
  /* `error` is the adapter's word that the tool FAILED, never the view's guess.
     Optional because an adapter that cannot tell says nothing, and an absent
     flag means "not known to have failed" rather than "succeeded". */
  z.object({
    type: z.literal('tool_result'),
    id: z.string(),
    output: z.unknown(),
    error: z.boolean().optional(),
    parent: z.string().optional()
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
  z.object({
    type: z.literal('state_change'),
    state: AgentStateSchema,
    /** The run of the process whose state this is (`Session.run`): stamped by
     *  the host that publishes the frame, absent from an adapter's own. */
    run: z.number().optional()
  }),
  z.object({
    type: z.literal('session_meta'),
    model: z.string().nullable(),
    providerSessionId: z.string().nullable()
  }),
  /** The reasoning effort the session runs at, as the provider reports it,
   *  or as the adapter recorded a switch the provider applies at the next
   *  turn; null when the provider says the model runs at none or will not
   *  say. Sent at ready and after every switch of model or effort. */
  z.object({ type: z.literal('effort'), effort: z.string().nullable() }),
  z.object({ type: z.literal('error'), message: z.string(), fatal: z.boolean() }),
  /* The turn the reader's `interrupt` stopped ended there: the provider's word
     that it was cut short, never a failure. A view mutes the message that
     started it rather than raising an error card over it. */
  z.object({ type: z.literal('turn_interrupted') }),
  /** The agent no longer waits on this request: the provider withdrew it
   *  (Claude cancels a control request, Codex resolves a server request on
   *  its own), or the turn it belonged to ended with it unanswered. A view
   *  settles its card for good; an answer to it would only be refused. */
  z.object({ type: z.literal('permission_withdrawn'), id: z.string() }),
  /** A hosted form's answers changed under the card (PRDCT-4157): the agent
   *  set fields from what the person said (`clave_input_set`), or the form
   *  was approved and `sent` carries every answer to the views that did not
   *  send them. `answers` is the patch, by the question's key. */
  z.object({
    type: z.literal('permission_updated'),
    id: z.string(),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    sent: z.boolean().optional(),
    /** What the person typed, handed to a late view (PRDCT-4210): never the
     *  agent's fill. */
    typed: z.boolean().optional(),
    /** The agent's word under a field it could not fill, by the question's key. */
    notes: z.record(z.string(), z.string()).optional()
  }),
  /** What a permission request does, read where the session runs
   *  (PRDCT-4331): its level (the rules' floor, raised and never lowered by
   *  the explainer's reading), the plain sentence and whether it matches the
   *  person's ask; or, with `failed`, why no sentence came. Keyed by the
   *  request's id; it never answers the request. Mirrors
   *  `packages/contract/src/sessions.ts`. */
  z.object({
    type: z.literal('permission_explained'),
    id: z.string(),
    /** Absent: no level to show (the rules could not tell, and the reading
     *  did not give one of the upper levels): "Not verified". */
    level: z.enum(['reads', 'project', 'outside', 'irreversible']).optional(),
    sentence: z.string().optional(),
    asked: z.enum(['yes', 'no', 'unclear']).optional(),
    failed: z.string().optional()
  }),
  /** How full the conversation's context is (or, with `parent`, a subagent's):
   *  the tokens its last call read and wrote, and the model's window once the
   *  provider has named it. The
   *  provider's raw frames stay in main, so this is the only way a view can
   *  know it. */
  z.object({
    type: z.literal('context_usage'),
    used: z.number(),
    window: z.number().nullable(),
    /** A subagent's own context, named by the call that started it. */
    parent: z.string().optional()
  }),
  /** The model a subagent runs on, as its own first answer names it (an
   *  agent inherits the conversation's model unless its call or its
   *  definition names another, so the call alone cannot tell). */
  z.object({ type: z.literal('subagent_model'), parent: z.string(), model: z.string() }),
  /** The mode the session is in and the modes it may be switched to; sent at
   *  ready and again whenever the provider reports a change. A provider with
   *  no modes never sends it, and a view shows no switch. */
  z.object({
    type: z.literal('permission_mode'),
    mode: z.string(),
    modes: z.array(PermissionModeOptionSchema)
  }),
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
