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

/** A view of the live sessions, never a change to their ownership or order.
 * Only follow links whose rows are reachable in this particular sidebar view.
 * Search passes no candidates so its results remain direct session links.
 * An editable target is a temporary presented root, with its real links intact.
 * Any local tab nested under another folds under it, whatever it runs: an
 * agent, a plain terminal (PRDCT-4997), since a person can now nest any tab by
 * a drag. A remote session stays an ordinary row, as its record lives on
 * another machine's terms.
 * A session with a work assignment (PRDCT-4123) is never folded under the tab
 * it is nested under, and the climb stops at the first one: work membership
 * wins over the nesting, and a tab nested under a member folds into that
 * member's wave or lane entry (`work-presentation.ts`). */
export function subagentPresentation(
  sessions: readonly Session[],
  reachableIds: ReadonlySet<string>,
  editableRootId?: string | null
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
    while (!current.work && current.sessionType === 'local' && current.spawnedBy) {
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
    // Validate the full ancestry before cutting the presented path. Otherwise
    // an edit inside a malformed cycle could accidentally make that cycle fold.
    const editableDepth = editableRootId ? [...seen].indexOf(editableRootId) : -1
    const rootId = editableDepth >= 0 && editableRootId ? editableRootId : current.id
    if (rootId === session.id) continue
    rootById.set(session.id, rootId)
    depths.set(session.id, editableDepth >= 0 ? editableDepth : seen.size - 1)
    const children = descendants.get(rootId) ?? []
    children.push(session)
    descendants.set(rootId, children)
  }
  for (const children of descendants.values()) {
    children.sort((a, b) => depths.get(a.id)! - depths.get(b.id)!)
  }
  return { rootById, descendants }
}

/** The focused tab is always in sight (PRDCT-4998): the nest to open for it,
 * once each time the tab on screen comes to sit in a nest. That is when the
 * focus moves onto a nested tab, and also when the focus does not move at all:
 * the tab's parent arrives after it (a restart places the tabs one at a time,
 * in the order they come back), or the tab is nested while it has the focus.
 * `seen` is what the last answer was given for. The same tab under the same
 * parent asks for nothing again, so a person can fold that nest and it stays
 * folded. A parent drawn by a wave or lane entry has no nest of its own to
 * open (`drawsNest` says no): nothing is remembered, so its nest opens the
 * moment it draws one. */
export function nestToShowFocus(
  seen: string | null,
  focusedId: string | null,
  rootById: ReadonlyMap<string, string>,
  drawsNest: (rootId: string) => boolean
): { seen: string | null; open: string | null } {
  const root = focusedId ? rootById.get(focusedId) : undefined
  if (!root || !drawsNest(root)) return { seen: null, open: null }
  const key = `${focusedId}\n${root}`
  return { seen: key, open: key === seen ? null : root }
}
