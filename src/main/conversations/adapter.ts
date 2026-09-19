import type {
  AgentCapabilities,
  AgentResponse,
  ConversationEvent,
  ConversationOptions
} from '../../shared/agent-session'

/**
 * Resolved by trusted main-process launch settings, never by a renderer.
 * Environment is transient: do not persist it or expose it in a snapshot.
 */
export interface AdapterLaunch {
  command: string[]
  additionalArgs: string[]
  env: Record<string, string>
  sessionDirectory: string
  options: ConversationOptions
  providerSessionId?: string
  mcpConfigPath?: string
}

export type EmitConversationEvent = (event: ConversationEvent) => void

export interface ConversationAdapter {
  readonly capabilities: AgentCapabilities
  start(): Promise<void>
  send(text: string): Promise<void>
  interrupt(): Promise<void>
  respond(response: AgentResponse): Promise<void>
  dispose(): Promise<void>
}

export type AdapterFactory = (
  launch: AdapterLaunch,
  emit: EmitConversationEvent
) => ConversationAdapter
