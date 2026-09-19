import * as fs from 'fs'
import * as path from 'path'
import { sessionRecordsDir } from './sessions/adapters/pty-backend'
import { workspaceManager } from './workspace-manager'

/** Session id → workspace, read straight from the session records on disk
 *  (stamped at spawn, else by cwd against the registered roots). Used by the
 *  one-time layout migration to place a bare session id of the legacy
 *  display order. Records are small JSON files; a malformed one is skipped. */
export function sessionWorkspaceResolver(): (sessionId: string) => string | null {
  const byId = new Map<string, string | null>()
  try {
    const dir = sessionRecordsDir()
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as {
          id?: unknown
          workspaceId?: unknown
          cwd?: unknown
        }
        if (typeof meta.id !== 'string') continue
        byId.set(
          meta.id,
          typeof meta.workspaceId === 'string'
            ? meta.workspaceId
            : typeof meta.cwd === 'string'
              ? workspaceManager.resolveWorkspaceForCwd(meta.cwd)
              : null
        )
      } catch {
        /* skip malformed record */
      }
    }
  } catch {
    /* no records dir yet */
  }
  return (id) => byId.get(id) ?? null
}

/** Records predating adapters all used the shared PTY adapter. */
export function migrateSessionAdapterRecord<
  T extends { adapterId?: string; transport?: 'pty' | 'events' }
>(record: T): T & { adapterId: string; transport: 'pty' | 'events' } {
  return { ...record, adapterId: record.adapterId ?? 'pty', transport: record.transport ?? 'pty' }
}
