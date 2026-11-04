export const API_VERSION = '1.0.0' as const

export type PluginSessionState = 'idle' | 'working' | 'blocked' | 'done' | 'ended'
export interface PluginSessionGroup {
  id: string
  name: string
}

export interface PluginSession {
  id: string
  cwd: string
  folderName: string
  alive: boolean
  provider: string
  providerSessionId: string | null
  name: string
  model: string | null
  state: PluginSessionState
  group: PluginSessionGroup | null
  workspaceId: string | null
  createdAt: number
}

export type PluginActionTargetKind = 'session' | 'group' | 'workspace'
export interface PluginActionTarget {
  kind: PluginActionTargetKind
  id: string
  workspaceId: string | null
}
export interface PluginActionPage {
  url: string
  title: string
}
export interface PluginActionResult {
  page: PluginActionPage | null
}
export interface PluginActionPreviewRow {
  label: string
  value: string
}
export interface PluginActionHandlers {
  invoke(target: PluginActionTarget): PluginActionResult | null | Promise<PluginActionResult | null>
  preview?(target: PluginActionTarget): PluginActionPreviewRow[] | Promise<PluginActionPreviewRow[]>
}
export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type PluginCommandHandler = (args?: unknown) => unknown | Promise<unknown>

export interface PluginAPI {
  readonly version: typeof API_VERSION
  sessions: {
    list(): Promise<PluginSession[]>
    get(id: string): Promise<PluginSession | null>
    subscribe(listener: (sessions: PluginSession[]) => void): Promise<() => void>
    /** The session the user is looking at, or null when no tab holds focus. */
    focused(): Promise<PluginSession | null>
    /** Listen to the host's `context.changed` push; returns the unsubscribe. Requires
     *  `sessions.read`, without which the host never pushes and the listener never fires. */
    onContextChanged(listener: (session: PluginSession | null) => void): () => void
    send(id: string, text: string): Promise<void>
  }
  ui: {
    registerPanel(id: string): Promise<void>
    registerToolbar(id: string): Promise<void>
    registerCommand(id: string, handler: PluginCommandHandler): Promise<void>
    registerAction(id: string, handlers: PluginActionHandlers): Promise<void>
  }
  notify(options: { title: string; body?: string }): Promise<void>
  secrets: {
    request(options: { title: string; description?: string }): Promise<string | null>
  }
  log(level: PluginLogLevel, message: string): Promise<void>
}
