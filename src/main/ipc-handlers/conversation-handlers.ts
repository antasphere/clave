import { BrowserWindow, ipcMain } from 'electron'
import { parseConversationCommand } from '../conversations/launch'
import { requireMigrationHost, requireSessionHome } from './session-migration-handlers'
import {
  closeConversation,
  conversationClient,
  createConversation,
  listConversations,
  sendConversation
} from '../conversations/runtime'

export function registerConversationHandlers(): void {
  ipcMain.handle('conversation:command', async (event, input: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('Conversation commands require an application window')
    const command = parseConversationCommand(input)
    switch (command.type) {
      case 'create':
        return createConversation(win, command.options)
      case 'list':
        return listConversations(win)
      case 'send':
        return sendConversation(command.sessionId, command.text, command.commandId)
      case 'close':
        await requireSessionHome(requireMigrationHost(event), command.sessionId)
        return closeConversation(command.sessionId)
      case 'snapshot':
        return (await conversationClient()).snapshot(command.sessionId)
      case 'interrupt':
        return (await conversationClient()).interrupt(command.sessionId)
      case 'respond':
        return (await conversationClient()).respond(command.sessionId, command.response)
      case 'publish-artifact':
        return (await conversationClient()).publishArtifact(
          command.sessionId,
          command.artifact,
          command.commandId
        )
    }
  })
}
