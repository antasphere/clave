import { z } from 'zod'
import type { PtySpawnOptions } from '../pty-manager'
import { type ConversationCommand, type ConversationProvider } from '../../shared/agent-session'
import { artifactInputSchema, providerIdSchema } from './plugin-records'

/** Adoption never converts an existing terminal process into a protocol session. */
export function conversationProviderForSpawn(
  options?: PtySpawnOptions
): ConversationProvider | null {
  if (options?.adoptTmuxName || options?.adoptSessionId) return null
  if (options?.piMode) return 'pi'
  if (options?.codexMode) return 'codex'
  if (options?.antigravityMode || options?.claudeAgentsMode || options?.claudeMode === false)
    return null
  return 'claude'
}

const text = z.string().min(1).max(4096)
const sessionId = z
  .string()
  .regex(/^conversation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const options = z
  .object({
    provider: providerIdSchema,
    cwd: text,
    title: z.string().max(200).optional(),
    workspaceId: text.optional(),
    launchProfileId: text.optional(),
    claudeProfileId: text.optional(),
    configDir: text.optional(),
    model: text.optional(),
    piProvider: text.optional(),
    piThinking: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    dangerousMode: z.boolean().optional(),
    resumeSessionId: text.optional()
  })
  .strict()
const response = z.union([
  z.object({ requestId: text, decision: z.enum(['allow', 'deny']) }).strict(),
  z.object({ requestId: text, answer: z.string().max(65_536) }).strict()
])
const command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), options }).strict(),
  z.object({ type: z.literal('list') }).strict(),
  z.object({ type: z.literal('snapshot'), sessionId }).strict(),
  z
    .object({
      type: z.literal('send'),
      sessionId,
      text: z.string().min(1).max(1_048_576),
      commandId: z.string().min(1).max(128)
    })
    .strict(),
  z.object({ type: z.literal('interrupt'), sessionId }).strict(),
  z.object({ type: z.literal('respond'), sessionId, response }).strict(),
  z.object({ type: z.literal('close'), sessionId }).strict(),
  z
    .object({
      type: z.literal('publish-artifact'),
      sessionId,
      artifact: artifactInputSchema,
      commandId: z.string().min(1).max(128)
    })
    .strict()
])

export function parseConversationCommand(value: unknown): ConversationCommand {
  const result = command.safeParse(value)
  if (!result.success) throw new Error('Invalid conversation command')
  return result.data
}
