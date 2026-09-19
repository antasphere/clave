import type { Session } from '../store/session-types'

/** Direct-only providers have no .clave representation. Never downgrade them to a shell. */
export function assertPinnableSessions(
  sessions: Pick<Session, 'id' | 'claudeMode' | 'codexMode' | 'piMode'>[]
): void {
  if (
    sessions.some(
      (session) =>
        session.id.startsWith('conversation-') &&
        !session.claudeMode &&
        !session.codexMode &&
        !session.piMode
    )
  ) {
    throw new Error(
      'OpenCode sessions cannot be pinned or exported as .clave yet. Custom provider sessions have the same limitation. Move these tabs out of this group before saving it.'
    )
  }
}
