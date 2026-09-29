import { ipcMain } from 'electron'
import { openclawClient, buildOpenclawWsUrl } from '../openclaw-client'
import { locationManager } from '../location-manager'
import { broadcastToAllWindows } from '../window-routing'
import { randomUUID } from 'crypto'
import type { ChatMessage } from '../../shared/remote-types'

export function registerAgentHandlers(): void {
  // Set up message forwarding to renderer
  openclawClient.onMessage((_locationId, message) => {
    broadcastToAllWindows(`agent:on-message:${message.agentId}`, message)
  })

  openclawClient.onAgentsUpdate((locationId, agents) => {
    broadcastToAllWindows('agent:agents-updated', locationId, agents)
  })

  ipcMain.handle('agent:list', async (_event, locationId: string) => {
    const loc = locationManager.getLocations().find((l) => l.id === locationId)
    if (!loc?.openclawPort || !loc.host) return []
    openclawClient.requestAgents(locationId)
    // Return will come via agent:agents-updated event
    return []
  })

  ipcMain.handle('agent:connect', async (_event, locationId: string) => {
    const loc = locationManager.getLocations().find((l) => l.id === locationId)
    if (!loc?.host || !loc.openclawPort) throw new Error('Location not configured for agents')
    const wsUrl = buildOpenclawWsUrl(loc)
    const token = locationManager.getOpenclawToken(locationId)
    await openclawClient.connect(locationId, wsUrl, token)
  })

  ipcMain.handle('agent:disconnect', (_event, locationId: string) => {
    openclawClient.disconnect(locationId)
  })

  ipcMain.handle('agent:sessions', async (_event, locationId: string) => {
    return openclawClient.requestSessions(locationId)
  })

  ipcMain.handle('agent:chat-history', async (_event, locationId: string, sessionKey: string) => {
    return openclawClient.requestChatHistory(locationId, sessionKey)
  })

  ipcMain.handle(
    'agent:send',
    async (_event, agentId: string, locationId: string, content: string) => {
      // Return optimistic message immediately, send async
      const msg: ChatMessage = {
        id: randomUUID(),
        agentId,
        role: 'user',
        content,
        timestamp: Date.now(),
        status: 'sending'
      }
      openclawClient.sendToAgent(locationId, agentId, content).catch(() => {
        // Message delivery failed — could notify renderer
      })
      return msg
    }
  )
}
