/**
 * Clave's conversation protocol. Provider wire formats never cross this boundary.
 * A session owns its history and provider identity; a window is only a subscriber.
 */
import type { ArtifactInput, ConversationArtifact, PluginBindings } from './runtime-plugins'
import type { AttachedSessionView, LegacyImportState } from './session-migration'

export const CONVERSATION_PROVIDERS = ['claude', 'codex', 'opencode', 'pi'] as const
export type BuiltinConversationProvider = (typeof CONVERSATION_PROVIDERS)[number]
export type ConversationProvider = string
export const SESSION_PROTOCOL_VERSION = 2

export interface AgentCapabilities {
  permissions: boolean
  questions: boolean
  resume: boolean
  /** A provider-specific limitation, displayed rather than silently bypassed. */
  notice?: string
}

export type ConversationStatus =
  | 'starting'
  | 'idle'
  | 'running'
  | 'waiting'
  | 'stopped'
  | 'error'
  | 'closed'

export interface ConversationOptions {
  provider: ConversationProvider
  cwd: string
  title?: string
  workspaceId?: string
  windowKey?: string
  launchProfileId?: string
  claudeProfileId?: string
  configDir?: string
  model?: string
  piProvider?: string
  piThinking?: string
  dangerousMode?: boolean
  resumeSessionId?: string
  /** Assigned by the host, never accepted from an untrusted create command. */
  pluginBindings?: PluginBindings
}

export interface ConversationSession extends ConversationOptions {
  id: string
  createdAt: string
  updatedAt: string
  status: ConversationStatus
  capabilities: AgentCapabilities
  providerSessionId?: string
  error?: string
  /** Host migration transaction; callers cannot supply this in create options. */
  legacyImport?: LegacyImportState
  view?: AttachedSessionView
}

export interface ConversationMessage {
  kind: 'message'
  id: string
  role: 'user' | 'assistant'
  text: string
}

export interface ConversationTool {
  kind: 'tool'
  id: string
  name: string
  input?: string
  output?: string
  status: 'running' | 'completed' | 'failed'
}

export interface AgentRequest {
  id: string
  kind: 'permission' | 'question'
  title: string
  description?: string
  /** A plain question can offer choices or accept a free-text answer. */
  choices?: string[]
}

export type AgentResponse =
  | { requestId: string; decision: 'allow' | 'deny' }
  | { requestId: string; answer: string }

export type ConversationEvent =
  | { type: 'status'; status: ConversationStatus; error?: string }
  | { type: 'capabilities'; capabilities: AgentCapabilities }
  | { type: 'provider-session'; providerSessionId: string }
  | { type: 'message'; message: ConversationMessage }
  | { type: 'text-delta'; messageId: string; text: string }
  | { type: 'tool'; tool: ConversationTool }
  | { type: 'artifact'; artifact: ConversationArtifact }
  | { type: 'request'; request: AgentRequest }
  | { type: 'request-resolved'; requestId: string }
  | { type: 'turn-end'; outcome: 'completed' | 'interrupted' | 'failed'; error?: string }

export interface ConversationEnvelope {
  sessionId: string
  sequence: number
  timestamp: string
  event: ConversationEvent
}

export interface ConversationSnapshot {
  session: ConversationSession
  sequence: number
  entries: (ConversationMessage | ConversationTool | ConversationArtifact)[]
  requests: AgentRequest[]
  /** Live service state, not persisted history or a renderer-owned process. */
  providerConnected?: boolean
}

/** Public commands carry no executables, arbitrary environment, or credentials. */
export type ConversationCommand =
  | { type: 'create'; options: ConversationOptions }
  | { type: 'list' }
  | { type: 'snapshot'; sessionId: string }
  | { type: 'send'; sessionId: string; text: string; commandId: string }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'respond'; sessionId: string; response: AgentResponse }
  | { type: 'close'; sessionId: string }
  | { type: 'publish-artifact'; sessionId: string; artifact: ArtifactInput; commandId: string }

export interface ConversationAPI {
  create(options: ConversationOptions): Promise<ConversationSnapshot>
  list(): Promise<ConversationSession[]>
  snapshot(sessionId: string): Promise<ConversationSnapshot>
  send(sessionId: string, text: string, commandId: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  respond(sessionId: string, response: AgentResponse): Promise<void>
  close(sessionId: string): Promise<void>
  publishArtifact(
    sessionId: string,
    artifact: ArtifactInput,
    commandId: string
  ): Promise<ConversationArtifact>
  onEvent(callback: (event: ConversationEnvelope) => void): () => void
}

/** Pure projection shared by the service and renderer. Envelopes are ordered by the service. */
export function applyConversationEvent(
  snapshot: ConversationSnapshot,
  envelope: ConversationEnvelope
): ConversationSnapshot {
  if (envelope.sessionId !== snapshot.session.id || envelope.sequence <= snapshot.sequence)
    return snapshot
  const { event } = envelope
  const next: ConversationSnapshot = {
    ...snapshot,
    session: { ...snapshot.session, updatedAt: envelope.timestamp },
    sequence: envelope.sequence,
    entries: [...snapshot.entries],
    requests: [...snapshot.requests]
  }
  switch (event.type) {
    case 'status':
      next.session.status = event.status
      next.session.error = event.error
      if (['stopped', 'error', 'closed'].includes(event.status)) next.requests = []
      break
    case 'capabilities':
      next.session.capabilities = event.capabilities
      break
    case 'provider-session':
      next.session.providerSessionId = event.providerSessionId
      break
    case 'message': {
      const index = next.entries.findIndex((entry) => entry.id === event.message.id)
      if (index < 0) next.entries.push(event.message)
      else next.entries[index] = event.message
      break
    }
    case 'text-delta': {
      const index = next.entries.findIndex((entry) => entry.id === event.messageId)
      const previous = next.entries[index]
      if (previous?.kind === 'message')
        next.entries[index] = { ...previous, text: previous.text + event.text }
      else
        next.entries.push({
          kind: 'message',
          id: event.messageId,
          role: 'assistant',
          text: event.text
        })
      break
    }
    case 'tool': {
      const index = next.entries.findIndex((entry) => entry.id === event.tool.id)
      if (index < 0) next.entries.push(event.tool)
      else next.entries[index] = { ...next.entries[index], ...event.tool }
      break
    }
    case 'artifact': {
      const index = next.entries.findIndex((entry) => entry.id === event.artifact.id)
      if (index < 0) next.entries.push(event.artifact)
      else next.entries[index] = event.artifact
      break
    }
    case 'request':
      next.requests = [
        ...next.requests.filter((request) => request.id !== event.request.id),
        event.request
      ]
      next.session.status = 'waiting'
      break
    case 'request-resolved':
      next.requests = next.requests.filter((request) => request.id !== event.requestId)
      if (!next.requests.length) next.session.status = 'running'
      break
    case 'turn-end':
      next.session.status = event.outcome === 'failed' ? 'error' : 'idle'
      next.session.error = event.error
      next.requests = []
      break
  }
  return next
}
