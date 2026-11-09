import type { ConversationTurn } from '../../../preload/index.d'

/**
 * The message trail's read of a tab's conversation (PRDCT-4207): a Pi tab by
 * its own id, a Claude tab under its own account directory when it ran with
 * one, since its transcript lives there rather than under `~/.claude`.
 */
export function readTrail(read: {
  cwd: string
  conversationId: string
  piMode?: boolean
  claudeConfigDir?: string
}): Promise<{ exists: boolean; turns: ConversationTurn[] }> {
  const provider = read.piMode ? ('pi' as const) : ('claude' as const)
  const configDir = read.piMode ? undefined : read.claudeConfigDir || undefined
  return window.electronAPI.historyConversation(read.cwd, read.conversationId, provider, configDir)
}
