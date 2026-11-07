/**
 * "Archive and kill session": the one decision, with no app imports so it is
 * unit-tested on its own (`archive-request.test.ts`). The delivery is
 * `archive-session.ts`.
 *
 * Archiving is the agent's work, not Clave's: `/exos:archive-session` reads the
 * conversation, files it on the project record and commits. Clave cannot know
 * when that is done, or whether it stopped to ask something, so the kill is
 * the agent's last step too — it closes its own tab through the Clave tool once
 * the archive is committed. A tab whose archive fails therefore stays open,
 * with the reason on screen, instead of being killed with nothing filed.
 */
import type { SessionMode } from './exchange-capture'

export const ARCHIVE_COMMAND = '/exos:archive-session'

export const ARCHIVE_AND_KILL_PROMPT =
  `${ARCHIVE_COMMAND} this session. ` +
  'Once the archive is committed, close this tab: call clave_close_session with sessionId "mine". ' +
  'If the archive cannot be completed, say why and leave the tab open.'

export type ArchiveRefusal = 'no-session' | 'ended' | 'not-claude'

/** Why a tab cannot be asked to archive itself, or null when it can. Only a
 *  live Claude Code tab runs the archive skill; `claude agents` is a menu, not
 *  a conversation, and a plain terminal would run the text as a command. */
export function archiveRefusal(
  session: { alive: boolean } | undefined,
  mode: SessionMode | undefined
): ArchiveRefusal | null {
  if (!session) return 'no-session'
  if (!session.alive) return 'ended'
  if (mode !== 'claude') return 'not-claude'
  return null
}
