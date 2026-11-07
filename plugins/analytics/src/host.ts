/**
 * The host API the plugin receives in `activate(api)`, written structurally so the
 * runnable bundle carries no runtime dependency on `@clave/plugin-sdk` (the shape of
 * `plugins/hello`). Kept identical to the SDK's contract by name, not by import.
 */
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
export type PluginSessionState = 'idle' | 'working' | 'blocked' | 'done' | 'ended'
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
  group: { id: string; name: string } | null
  workspaceId: string | null
  createdAt: number
}
export interface HostApi {
  sessions: {
    list(): Promise<PluginSession[]>
    subscribe(listener: (sessions: PluginSession[]) => void): Promise<() => void>
  }
  ui: { registerAction(id: string, handlers: PluginActionHandlers): Promise<void> }
  notify(options: { title: string; body?: string }): Promise<void>
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): Promise<void>
}
