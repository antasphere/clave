import { ipcMain } from 'electron'
import { agentUpdateManager } from '../agent-updates'
import { AGENT_UPDATE_TARGETS, type AgentUpdateId } from '../../shared/agent-updates'

const IDS = new Set<string>(AGENT_UPDATE_TARGETS.map((t) => t.id))

export function registerAgentUpdateHandlers(): void {
  // Pull, like the app updater: the renderer asks on mount rather than
  // hoping it was listening when the last push went out.
  ipcMain.handle('agent-updates:get-state', () => agentUpdateManager.getState())
  ipcMain.handle('agent-updates:check', () => agentUpdateManager.checkAll())
  ipcMain.handle('agent-updates:update', (_event, id: unknown) =>
    typeof id === 'string' && IDS.has(id)
      ? agentUpdateManager.update(id as AgentUpdateId)
      : agentUpdateManager.getState()
  )
  ipcMain.handle('agent-updates:set-auto', (_event, enabled: unknown) =>
    agentUpdateManager.setAutoUpdate(enabled === true)
  )
}
