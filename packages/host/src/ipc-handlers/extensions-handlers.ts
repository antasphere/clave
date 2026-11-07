import { ipcMain } from 'electron'
import { readClaudeInventory } from '../extensions-reader'
import {
  installPlugin,
  uninstallPlugin,
  setPluginEnabled,
  addMarketplace,
  removeMarketplace
} from '../extensions-mutator'
import type { MutationScope } from '../../../shared/src/extensions-types'

/** Read-only inventory + mutating operations for Claude Code extensions. */
export function registerExtensionsHandlers(): void {
  ipcMain.handle('extensions:get-inventory', (_event, configDir?: string) =>
    readClaudeInventory(configDir)
  )

  ipcMain.handle(
    'extensions:install-plugin',
    (_event, pluginId: string, scope: MutationScope, configDir?: string) =>
      installPlugin(pluginId, scope, configDir)
  )

  ipcMain.handle(
    'extensions:uninstall-plugin',
    (_event, pluginId: string, scope: MutationScope, configDir?: string) =>
      uninstallPlugin(pluginId, scope, configDir)
  )

  ipcMain.handle(
    'extensions:set-plugin-enabled',
    (_event, pluginId: string, enabled: boolean, scope: MutationScope, configDir?: string) =>
      setPluginEnabled(pluginId, enabled, scope, configDir)
  )

  ipcMain.handle('extensions:add-marketplace', (_event, source: string, configDir?: string) =>
    addMarketplace(source, configDir)
  )

  ipcMain.handle('extensions:remove-marketplace', (_event, name: string, configDir?: string) =>
    removeMarketplace(name, configDir)
  )
}
