import { z } from 'zod'

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

export const UserMessageSchema = z.object({ type: z.literal('user_message'), text: z.string() })
export type UserMessage = z.infer<typeof UserMessageSchema>
export const PermissionResponseSchema = z.object({
  type: z.literal('permission_response'),
  id: z.string(),
  optionId: z.string()
})
export const InterruptSchema = z.object({ type: z.literal('interrupt') })
/** Switch the session's model; null asks the provider for its own default. */
export const SetModelSchema = z.object({ type: z.literal('set_model'), model: z.string().nullable() })
export type SetModel = z.infer<typeof SetModelSchema>
export const SessionInputSchema = z.discriminatedUnion('type', [
  UserMessageSchema,
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
    input: z.unknown().optional()
  }),
  z.object({ type: z.literal('state_change'), state: AgentStateSchema }),
  z.object({
    type: z.literal('session_meta'),
    model: z.string().nullable(),
    providerSessionId: z.string().nullable()
  }),
  z.object({ type: z.literal('error'), message: z.string(), fatal: z.boolean() }),
  z.object({ type: z.literal('provider_event'), provider: z.string(), payload: z.unknown() })
])
export type SessionEvent = z.infer<typeof SessionEventSchema>
export const SessionStreamSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pty'), data: z.instanceof(Uint8Array) }),
  z.object({ kind: z.literal('event'), event: SessionEventSchema })
])
export type SessionStream = z.infer<typeof SessionStreamSchema>
