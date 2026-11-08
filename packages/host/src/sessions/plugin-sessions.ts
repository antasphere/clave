import type { PluginSession, PluginSessionGroup } from '@clave/plugin-sdk'
import type { SessionRecord } from '@clave/contract/sessions'
import type { Session } from '../../../shared/src/session-model'
import { sessionManager } from './session-manager'

/**
 * What the plugin host tells a plugin about a session, read from the session
 * registry rather than from the PTY manager. One source for the whole `sessions`
 * service: a chat session appears in the listing and can be the focused one, and
 * `alive` comes from the record's own state instead of a flag that only flips
 * once a renderer has attached.
 */
export function pluginSessionOf(
  session: Session,
  facts?: { record?: SessionRecord; group?: PluginSessionGroup | null }
): PluginSession {
  const record = facts?.record
  return {
    id: session.id,
    cwd: session.cwd,
    folderName: session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? session.cwd,
    alive: session.state !== 'ended',
    provider: session.provider,
    providerSessionId:
      record?.claudeSessionId ?? record?.codexThreadId ?? record?.piSessionId ?? null,
    name: session.title,
    model: record?.model ?? null,
    state: session.state,
    group: facts?.group ?? null,
    workspaceId: record?.workspaceId ?? null,
    createdAt: session.createdAt
  }
}

/** Every session the registry holds, whatever its transport. */
export function listPluginSessions(): PluginSession[] {
  return sessionManager.list().map((session) => pluginSessionOf(session))
}

/** One session by id, or null once the registry no longer holds it. */
export function pluginSessionById(id: string): PluginSession | null {
  const session = sessionManager.get(id)
  return session ? pluginSessionOf(session) : null
}
