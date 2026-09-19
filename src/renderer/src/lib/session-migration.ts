import type { LegacyMigrationResult } from '../../../shared/session-migration'
import { remapSessionId, remapSessionLayout } from '../../../shared/session-remap'
import { useSessionStore } from '../store/session-store'
import { conversationToSession } from './conversation-sessions'
import type { Session } from '../store/session-types'

let finishRecovery: (() => void | Promise<void>) | undefined
let recoveryRunning: Promise<void> | undefined

/** Boot must not persist a partial layout while the service cannot list sessions. */
export function deferConversationRecovery(finish: () => void | Promise<void>): void {
  finishRecovery = finish
}

export async function restartConversationService(): Promise<boolean> {
  if (!(await window.electronAPI.sessionMigration.restartService())) return false
  await refreshMigratedConversations()
  return true
}

interface MigrationState {
  sessions: Session[]
  groups: unknown[]
  displayOrder: string[]
  focusedSessionId: string | null
  selectedSessionIds: string[]
  activeSessionViewId: string | null
  workspaceSelections: Record<
    string,
    { focusedSessionId: string | null; selectedSessionIds: string[] }
  >
  sidebarUndoStack: unknown[]
}

export function remapMigrationState<T extends MigrationState>(
  state: T,
  mappings: Readonly<Record<string, string>>
): T {
  const id = (value: string): string => remapSessionId(value, mappings)
  const optional = (value: string | null): string | null => (value ? id(value) : null)
  const layout = remapSessionLayout(state, mappings)
  const references = [
    state.focusedSessionId,
    state.activeSessionViewId,
    ...state.selectedSessionIds,
    ...state.sessions.flatMap((session) => [
      session.id,
      session.spawnedBy,
      session.view?.serverSessionId
    ]),
    ...Object.values(state.workspaceSelections).flatMap((selection) => [
      selection.focusedSessionId,
      ...selection.selectedSessionIds
    ])
  ]
  if (layout === state && !references.some((value) => value && id(value) !== value)) return state
  const sessions = new Map<string, Session>()
  // Prefer an already-restored conversation over its old placeholder.
  for (const session of [...state.sessions].sort(
    (a, b) => Number(a.id in mappings) - Number(b.id in mappings)
  )) {
    const target = id(session.id)
    if (sessions.has(target)) continue
    sessions.set(target, {
      ...session,
      id: target,
      spawnedBy: session.spawnedBy ? id(session.spawnedBy) : session.spawnedBy,
      view: session.view
        ? {
            ...session.view,
            serverSessionId: session.view.serverSessionId
              ? id(session.view.serverSessionId)
              : session.view.serverSessionId
          }
        : undefined
    })
  }
  return {
    ...layout,
    sessions: [...sessions.values()],
    focusedSessionId: optional(state.focusedSessionId),
    selectedSessionIds: [...new Set(state.selectedSessionIds.map(id))],
    activeSessionViewId: optional(state.activeSessionViewId),
    workspaceSelections: Object.fromEntries(
      Object.entries(state.workspaceSelections).map(([key, selection]) => [
        key,
        {
          focusedSessionId: optional(selection.focusedSessionId),
          selectedSessionIds: [...new Set(selection.selectedSessionIds.map(id))]
        }
      ])
    ),
    // Undoing a pre-migration snapshot could resurrect terminal IDs whose
    // processes have deliberately stopped. New layout edits form a new stack.
    sidebarUndoStack: []
  } as T
}

export function applySessionMappings(mappings: Readonly<Record<string, string>>): void {
  if (!Object.keys(mappings).length) return
  useSessionStore.setState((state) => remapMigrationState(state, mappings))
}

export function applySessionMigration(result: LegacyMigrationResult): void {
  const next = conversationToSession(result.snapshot.session)
  useSessionStore.setState((state) => {
    const original =
      state.sessions.find((session) => session.id === next.id) ??
      state.sessions.find((session) => session.id === result.legacyId)
    const mapped = remapMigrationState(state, { [result.legacyId]: next.id })
    const replacement = {
      ...next,
      view: original?.view
        ? {
            ...original.view,
            serverSessionId: original.view.serverSessionId
              ? remapSessionId(original.view.serverSessionId, { [result.legacyId]: next.id })
              : original.view.serverSessionId
          }
        : next.view
    }
    const exists = mapped.sessions.some((session) => session.id === next.id)
    return {
      ...mapped,
      sessions: exists
        ? mapped.sessions.map((session) => (session.id === next.id ? replacement : session))
        : [...mapped.sessions, replacement]
    }
  })
}

export async function refreshMigratedConversations(): Promise<void> {
  const mappings = await window.electronAPI.sessionMigration.mappings().catch(() => ({}))
  applySessionMappings(mappings)
  const sessions = await window.electronAPI.conversations.list()
  for (const session of sessions) {
    if (session.status === 'closed') continue
    if (session.legacyImport)
      applySessionMigration({
        legacyId: session.legacyImport.sourceId,
        snapshot: { session, sequence: 0, entries: [], requests: [] }
      })
    else useSessionStore.getState().adoptSessionInPlace(conversationToSession(session))
  }
  const { retryPendingRehomes } = await import('./adopt-record')
  await retryPendingRehomes()
  const finish = finishRecovery
  if (finish) {
    if (!recoveryRunning) {
      recoveryRunning = Promise.resolve()
        .then(finish)
        .then(() => {
          if (finishRecovery === finish) finishRecovery = undefined
        })
        .finally(() => {
          recoveryRunning = undefined
        })
    }
    await recoveryRunning
  }
}
