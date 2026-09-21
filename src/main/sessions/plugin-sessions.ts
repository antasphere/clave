import type { PluginSession } from '@clave/plugin-sdk'
import type { Session } from '../../shared/session-model'
import { sessionManager } from './session-manager'

/**
 * What the plugin host tells a plugin about a session, read from the session
 * registry rather than from the PTY manager. One source for the whole `sessions`
 * service: a chat session appears in the listing and can be the focused one, and
 * `alive` comes from the record's own state instead of a flag that only flips
 * once a renderer has attached.
 */
export function pluginSessionOf(session: Session): PluginSession {
  return {
    id: session.id,
    cwd: session.cwd,
    folderName: session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? session.cwd,
    alive: session.state !== 'ended'
  }
}

/** Every session the registry holds, whatever its transport. */
export function listPluginSessions(): PluginSession[] {
  return sessionManager.list().map(pluginSessionOf)
}

/** One session by id, or null once the registry no longer holds it. */
export function pluginSessionById(id: string): PluginSession | null {
  const session = sessionManager.get(id)
  return session ? pluginSessionOf(session) : null
}
