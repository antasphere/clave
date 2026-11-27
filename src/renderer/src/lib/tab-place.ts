import type { Session, SessionGroup } from '../store/session-types'

/**
 * Where a tab sat in the sidebar when its close began (PRDCT-5315), so a
 * close that fails can put it back where the person left it: inside its
 * group or at the top level, after the row that preceded it, and in the
 * group terminal slot it filled. Neighbours rather than indexes: other rows
 * may come and go while the stop runs.
 */
export interface TabPlace {
  session: Session
  /** The group holding it, or null at the top level. */
  groupId: string | null
  /** The row just above it in that container, or null when it was first. */
  after: string | null
  /** Its index in that container, used when `after` is gone. */
  index: number
  /** The group terminal slot it filled (a quick-launch terminal), if any. */
  terminal: { groupId: string; terminalId: string } | null
}

interface Layout {
  sessions: Session[]
  groups: SessionGroup[]
  displayOrder: string[]
}

/** The tab's place, read before it leaves the store; null for an unknown id. */
export function tabPlaceOf(state: Layout, id: string): TabPlace | null {
  const session = state.sessions.find((s) => s.id === id)
  if (!session) return null
  const group = state.groups.find((g) => g.sessionIds.includes(id)) ?? null
  const container = group ? group.sessionIds : state.displayOrder
  const index = Math.max(0, container.indexOf(id))
  const slot = state.groups
    .flatMap((g) => g.terminals.map((t) => ({ groupId: g.id, terminalId: t.id, sid: t.sessionId })))
    .find((t) => t.sid === id)
  return {
    session,
    groupId: group?.id ?? null,
    after: index > 0 ? container[index - 1] : null,
    index,
    terminal: slot ? { groupId: slot.groupId, terminalId: slot.terminalId } : null
  }
}

function insertAt(list: string[], id: string, after: string | null, index: number): string[] {
  const rest = list.filter((x) => x !== id)
  const at =
    after !== null && rest.includes(after)
      ? rest.indexOf(after) + 1
      : after === null
        ? 0
        : Math.min(index, rest.length)
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

/**
 * The layout with the tab back in its place. A tab something already put
 * back (a server's snapshot listing it again) keeps the row it has: only a
 * tab no container holds is placed. A group that no longer exists sends it
 * to the top level, where the person can still see and close it.
 */
export function restoreTabPlace(state: Layout, place: TabPlace): Layout {
  const id = place.session.id
  const present = state.sessions.some((s) => s.id === id)
  const sessions = present ? state.sessions : [...state.sessions, place.session]
  const terminalSlot = place.terminal
  const held =
    state.displayOrder.includes(id) ||
    state.groups.some(
      (g) => g.sessionIds.includes(id) || g.terminals.some((t) => t.sessionId === id)
    )
  let groups = state.groups
  if (terminalSlot) {
    groups = groups.map((g) =>
      g.id === terminalSlot.groupId
        ? {
            ...g,
            terminals: g.terminals.map((t) =>
              t.id === terminalSlot.terminalId && t.sessionId === null ? { ...t, sessionId: id } : t
            )
          }
        : g
    )
  }
  if (held) return { sessions, groups, displayOrder: state.displayOrder }
  const group = place.groupId ? groups.find((g) => g.id === place.groupId) : undefined
  if (group) {
    return {
      sessions,
      groups: groups.map((g) =>
        g.id === group.id
          ? { ...g, sessionIds: insertAt(g.sessionIds, id, place.after, place.index) }
          : g
      ),
      displayOrder: state.displayOrder
    }
  }
  // A group terminal lives in its slot, not in a container of rows.
  const inSlot = groups.some((g) => g.terminals.some((t) => t.sessionId === id))
  if (inSlot) return { sessions, groups, displayOrder: state.displayOrder }
  return {
    sessions,
    groups,
    displayOrder: insertAt(state.displayOrder, id, place.groupId ? null : place.after, place.index)
  }
}

/** Where a group sat when its Delete began, its members and slots as they were. */
export interface GroupPlace {
  group: SessionGroup
  after: string | null
  index: number
}

export function groupPlaceOf(state: Layout, groupId: string): GroupPlace | null {
  const group = state.groups.find((g) => g.id === groupId)
  if (!group) return null
  const index = Math.max(0, state.displayOrder.indexOf(groupId))
  return { group, after: index > 0 ? state.displayOrder[index - 1] : null, index }
}

/**
 * The group back in its place around the tabs whose close failed
 * (PRDCT-5315): a group is not deleted while a tab of it still runs, as it
 * never was. Run as each failure lands, so a failed tab goes back into its
 * group at once rather than sitting at the top level until every stop has
 * returned: the first failure brings the group back, the next ones join it,
 * each in its old order. Only tabs the store still holds go in (one closed
 * again meanwhile is gone for good), and the terminals that did close leave
 * their slots empty.
 */
export function restoreGroupPlace(state: Layout, place: GroupPlace, failed: Set<string>): Layout {
  const live = new Set(state.sessions.map((s) => s.id))
  const existing = state.groups.find((g) => g.id === place.group.id)
  const already = new Set([
    ...(existing?.sessionIds ?? []),
    ...(existing?.terminals.map((t) => t.sessionId) ?? [])
  ])
  const back = new Set([...failed].filter((id) => live.has(id) && !already.has(id)))
  if (back.size === 0) return state
  const members = new Set([...(existing?.sessionIds ?? []), ...back])
  const sessionIds = [
    ...place.group.sessionIds.filter((id) => members.has(id)),
    ...(existing?.sessionIds ?? []).filter((id) => !place.group.sessionIds.includes(id))
  ]
  const terminals = place.group.terminals.map((t) => {
    if (t.sessionId !== null && back.has(t.sessionId)) return t
    const kept = existing?.terminals.find((e) => e.id === t.id)
    return kept ?? { ...t, sessionId: null }
  })
  const group: SessionGroup = { ...(existing ?? place.group), sessionIds, terminals }
  const others = state.groups
    .filter((g) => g.id !== group.id)
    .map((g) => ({
      ...g,
      sessionIds: g.sessionIds.filter((id) => !back.has(id)),
      terminals: g.terminals.map((t) =>
        t.sessionId !== null && back.has(t.sessionId) ? { ...t, sessionId: null } : t
      )
    }))
  const groups = existing
    ? state.groups.map((g) =>
        g.id === group.id ? group : (others.find((o) => o.id === g.id) ?? g)
      )
    : [...others, group]
  const order = state.displayOrder.filter((id) => !back.has(id))
  return {
    sessions: state.sessions,
    groups,
    displayOrder: existing ? order : insertAt(order, group.id, place.after, place.index)
  }
}
