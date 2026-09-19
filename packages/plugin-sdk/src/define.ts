import type { PluginAPI } from './api'

export interface PluginDefinition {
  activate(api: PluginAPI): void | Promise<void>
  deactivate?(): void | Promise<void>
}

export function definePlugin<T extends PluginDefinition>(plugin: T): T {
  return plugin
}
