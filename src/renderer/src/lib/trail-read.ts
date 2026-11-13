import type { ConversationTurn } from '../../../preload/index.d'

/** The fields of a tab the message trail reads its conversation by. */
export interface TrailSession {
  cwd?: string
  claudeSessionId?: string | null
  piSessionId?: string | null
  piMode?: boolean
  opencodeMode?: boolean
  claudeConfigDir?: string
}

/**
 * The message trail's read of a tab's conversation (PRDCT-4207), taken from
 * the tab itself so no caller can drop a field: a Pi tab by its own id, a
 * Claude tab under its own account directory when it ran with one, since its
 * transcript lives there rather than under `~/.claude`. Null when the tab has
 * no conversation to read yet.
 */
export function readTrail(
  session: TrailSession
): Promise<{ exists: boolean; turns: ConversationTurn[] }> | null {
  const conversationId = session.claudeSessionId ?? session.piSessionId ?? null
  if (!session.cwd || !conversationId) return null
  const provider = session.piMode ? ('pi' as const) : ('claude' as const)
  const configDir = session.piMode ? undefined : session.claudeConfigDir || undefined
  return window.electronAPI.historyConversation(session.cwd, conversationId, provider, configDir)
}
