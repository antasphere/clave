import type { Session } from '../store/session-types'
import { tabIndicators, type TabStatus } from './tab-status'

/** Folded children have their own attention signal; never replace the parent's. */
export function subagentAttention(descendants: readonly Session[]): {
  status: TabStatus
  sessions: Session[]
} {
  for (const status of ['needs-you', 'unread', 'working'] as const) {
    const sessions = descendants.filter((s) => tabIndicators(s).status === status)
    if (sessions.length) return { status, sessions }
  }
  return { status: 'idle', sessions: [] }
}

function isLocalAgent(session: Session): boolean {
  return (
    session.sessionType === 'local' &&
    !!(
      session.claudeMode ||
      session.claudeAgentsMode ||
      session.codexMode ||
      session.antigravityMode ||
      session.piMode
    )
  )
}

/** A view of the live sessions, never a change to their ownership or order.
 * Only follow links whose rows are reachable in this particular sidebar view.
 * Search passes no candidates so its results remain direct session links. */
export function subagentPresentation(
  sessions: readonly Session[],
  reachableIds: ReadonlySet<string>
): {
  rootById: Map<string, string>
  descendants: Map<string, Session[]>
} {
  const available = new Map(sessions.filter((s) => reachableIds.has(s.id)).map((s) => [s.id, s]))
  const rootById = new Map<string, string>()
  const descendants = new Map<string, Session[]>()
  const depths = new Map<string, number>()
  for (const session of available.values()) {
    let current = session
    const seen = new Set([current.id])
    while (isLocalAgent(current) && current.spawnedBy) {
      const parent = available.get(current.spawnedBy)
      if (!parent || parent.sessionType !== 'local' || parent.workspaceId !== session.workspaceId)
        break
      if (seen.has(parent.id)) {
        // Malformed cycles, including branches into them, stay individually reachable.
        current = session
        break
      }
      seen.add(parent.id)
      current = parent
    }
    if (current.id === session.id) continue
    rootById.set(session.id, current.id)
    depths.set(session.id, seen.size - 1)
    const children = descendants.get(current.id) ?? []
    children.push(session)
    descendants.set(current.id, children)
  }
  for (const children of descendants.values()) {
    children.sort((a, b) => depths.get(a.id)! - depths.get(b.id)!)
  }
  return { rootById, descendants }
}
