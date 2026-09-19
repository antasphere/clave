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
  title: z.string()
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
export const SessionInputSchema = z.discriminatedUnion('type', [
  UserMessageSchema,
  PermissionResponseSchema,
  InterruptSchema
])
export type SessionInput = z.infer<typeof SessionInputSchema>
export const SessionEventSchema = z.discriminatedUnion('type', [
  UserMessageSchema,
  z.object({ type: z.literal('assistant_text'), delta: z.string(), final: z.boolean() }),
  z.object({ type: z.literal('tool_call'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool_result'), id: z.string(), output: z.unknown() }),
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
