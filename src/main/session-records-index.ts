import { lazyTerminalPorts } from './ports/terminals'
import { readJson } from './ports/storage'
import { SESSION_RECORDS_FOLDER, sessionRecordsDir } from './sessions/adapters/pty-backend'
import { workspaceManager } from './workspace-manager'

/** Session id → workspace, read straight from the session records (stamped
 *  at spawn, else by cwd against the registered roots). Used by the one-time
 *  layout migration to place a bare session id of the legacy display order.
 *  Records are small JSON documents of the storage port; a malformed one is
 *  skipped. */
export function sessionWorkspaceResolver(): (sessionId: string) => string | null {
  const byId = new Map<string, string | null>()
  sessionRecordsDir()
  const storage = lazyTerminalPorts.storage
  for (const file of storage.list(SESSION_RECORDS_FOLDER).filter((f) => f.endsWith('.json'))) {
    const meta = readJson(storage, `${SESSION_RECORDS_FOLDER}/${file}`) as {
      id?: unknown
      workspaceId?: unknown
      cwd?: unknown
    } | null
    if (!meta || typeof meta !== 'object' || typeof meta.id !== 'string') continue
    byId.set(
      meta.id,
      typeof meta.workspaceId === 'string'
        ? meta.workspaceId
        : typeof meta.cwd === 'string'
          ? workspaceManager.resolveWorkspaceForCwd(meta.cwd)
          : null
    )
  }
  return (id) => byId.get(id) ?? null
}

/** Records predating adapters all used the shared PTY adapter. */
export function migrateSessionAdapterRecord<
  T extends { adapterId?: string; transport?: 'pty' | 'events' }
>(record: T): T & { adapterId: string; transport: 'pty' | 'events' } {
  return { ...record, adapterId: record.adapterId ?? 'pty', transport: record.transport ?? 'pty' }
}
