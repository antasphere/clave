import type { AgentCapabilities, ConversationSnapshot, ConversationTool } from './agent-session'

/** Internal extension API. Unsupported versions are rejected, not guessed. */
export const RUNTIME_PLUGIN_API_VERSION = 1
export const RUNTIME_PLUGIN_ID_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/
export const PLUGIN_CAPABILITIES = [
  'conversation.read',
  'composer.setDraft',
  'conversation.send',
  'workspace.readFile',
  'workspace.execute',
  'ui.openFile',
  'ui.openArtifact'
] as const
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number]

export interface PluginPin {
  pluginId: string
  revision: string
  version: string
}

export interface PluginBindings {
  provider: PluginPin
  views: PluginPin[]
}

export interface PluginProviderContribution {
  id: string
  name: string
  /** Built, self-contained CommonJS module exporting createAdapter(launch, emit). */
  entry: string
  command: string[]
  capabilities: AgentCapabilities
}

export interface PluginViewContribution {
  id: string
  name: string
  /** Self-contained HTML document. Runtime assets/network are denied by default. */
  entry: string
  mimeTypes?: string[]
  toolNames?: string[]
  capabilities: PluginCapability[]
}

export interface RuntimePluginManifest {
  apiVersion: 1
  id: string
  name: string
  version: string
  provider?: PluginProviderContribution
  views: PluginViewContribution[]
}

export interface InstalledRuntimePlugin {
  manifest: RuntimePluginManifest
  revision: string
  enabled: boolean
  builtin: boolean
}

export interface PluginProviderDescriptor {
  id: string
  name: string
  plugin: PluginPin
}

export interface PluginViewDescriptor {
  id: string
  name: string
  plugin: PluginPin
  capabilities: PluginCapability[]
}

export interface ConversationArtifact {
  kind: 'artifact'
  id: string
  title: string
  mimeType: 'text/html' | 'text/markdown' | 'text/plain' | 'application/json'
  /** Clave stores content, not a transient external URL. Never interpreted by the host. */
  content: string
  fallback: string
  sourceUrl?: string
}

export type ArtifactInput = Omit<ConversationArtifact, 'kind' | 'id'>
export type PluginViewEntry = ConversationArtifact | ConversationTool

export interface PluginViewLease {
  id: string
  /** Host-owned private protocol URL; iframe runs with sandbox="allow-scripts". */
  url: string
  sessionId: string
  entry: PluginViewEntry
  view?: PluginViewDescriptor
  capabilities: PluginCapability[]
}

export interface PluginJob {
  id: string
  sessionId: string
  plugin: PluginPin
  argv: string[]
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  output: string
  truncated: boolean
  exitCode?: number
  createdAt: string
  finishedAt?: string
}

export type PluginRpcMethod = PluginCapability | 'workspace.jobRead' | 'workspace.cancelJob'

export interface PluginRpcRequest {
  id: string
  method: PluginRpcMethod
  params?: unknown
}

/**
 * Only the trusted host renderer can call these methods. An iframe gets a
 * MessagePort scoped to one lease, not this API or Electron's preload object.
 */
export interface RuntimePluginsAPI {
  list(): Promise<InstalledRuntimePlugin[]>
  install(): Promise<InstalledRuntimePlugin | null>
  update(pluginId: string): Promise<InstalledRuntimePlugin>
  setEnabled(pluginId: string, enabled: boolean): Promise<void>
  providers(): Promise<PluginProviderDescriptor[]>
  views(sessionId: string, entryId: string): Promise<PluginViewDescriptor[]>
  openView(
    sessionId: string,
    entryId: string,
    view?: PluginViewDescriptor
  ): Promise<PluginViewLease>
  closeView(leaseId: string): Promise<void>
  request(leaseId: string, request: PluginRpcRequest): Promise<unknown>
  onChanged(callback: () => void): () => void
}

export interface PluginFrameInit {
  type: 'clave:init'
  apiVersion: 1
  entry: PluginViewEntry
  capabilities: PluginCapability[]
}

export type PluginReadConversationResult = ConversationSnapshot
