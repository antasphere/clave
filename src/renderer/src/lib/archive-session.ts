import { useSessionStore } from '../store/session-store'
import { ARCHIVE_AND_KILL_PROMPT, archiveRefusal, type ArchiveRefusal } from './archive-request'
import { sessionMode } from './exchange-capture'
import { typeIntoAgentTab } from './mcp-dispatcher'

/**
 * Ask a Claude tab to archive its session and then close itself (see
 * `archive-request.ts` for why the close is the agent's). A chat tab takes the
 * prompt as a user message; a terminal tab has it typed into its input as one
 * turn, with the user's half-typed draft set aside and put back, exactly as a
 * message from another tab arrives. A busy agent takes it as its next turn.
 */
export async function requestArchiveAndKill(
  sessionId: string
): Promise<{ sent: true } | { sent: false; reason: ArchiveRefusal }> {
  const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
  const reason = archiveRefusal(session, session ? sessionMode(session) : undefined)
  if (reason) return { sent: false, reason }
  const record = (await window.electronAPI.sessionsList()).find((s) => s.id === sessionId)
  if (record?.transport === 'events') {
    await window.electronAPI.sessionsWrite(sessionId, {
      type: 'user_message',
      text: ARCHIVE_AND_KILL_PROMPT
    })
  } else {
    await typeIntoAgentTab(sessionId, ARCHIVE_AND_KILL_PROMPT)
  }
  return { sent: true }
}
