import { app } from 'electron'
import { RuntimePluginRegistry } from './registry'

let registry: RuntimePluginRegistry | undefined
export function runtimePluginRegistry(): RuntimePluginRegistry {
  return (registry ??= new RuntimePluginRegistry(app.getPath('userData')))
}
