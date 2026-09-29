/**
 * The sidebar's structural edit — moving rows — kept pure so vitest pins it
 * (the store wraps it in `set`, see `moveItems` in session-store.ts).
 *
 * The layout is two lists that have to agree:
 *   - `groups[].sessionIds`  — who is nested in which group, in order;
 *   - `displayOrder`         — the top level: group ids, standalone session
 *                              ids and file-tab ids, in order.
 *
 * Every move leaves these true, whatever it was handed:
 *   1. an id sits in at most ONE place — one group, or the top level, never
 *      both and never twice (a corrupted double placement is repaired, not
 *      propagated);
 *   2. a group is never nested inside a group — a group dropped "inside"
 *      another lands at the top level right after it;
 *   3. a group emptied BY the move is dropped; a group that was already empty
 *      (one an agent just created and is about to fill) is left alone;
 *   4. every group is reachable from the top level — a group missing from
 *      `displayOrder` is appended, since the list renders only what the
 *      order names.
 *
 * `targetId: null` means "the top level, at the end" — the explicit way to
 * ungroup. An id that names nothing (not a group, not nested, not at the
 * top level) is treated the same, so a stale target degrades to an ungroup
 * rather than a crash or a silent drop.
 */
export interface OpsGroup {
  id: string
  sessionIds: string[]
}

export interface OpsLayout<G extends OpsGroup> {
  groups: G[]
  displayOrder: string[]
}

export type MovePosition = 'before' | 'after' | 'inside'

/** Move `itemIds` (session ids, file-tab ids, or group ids) relative to
 *  `targetId`. Returns the new layout, or null when the move changes nothing —
 *  a drop back onto the row's own place, or a move a group cannot make (into
 *  itself, onto one of its own members). */
export function moveLayoutItems<G extends OpsGroup>(
  layout: OpsLayout<G>,
  itemIds: string[],
  targetId: string | null,
  position: MovePosition
): OpsLayout<G> | null {
  const groupById = new Map(layout.groups.map((g) => [g.id, g]))
  const ids = [...new Set(itemIds)].filter((id) => id !== targetId)
  if (ids.length === 0) return null

  const draggedGroupIds = ids.filter((id) => groupById.has(id))
  const draggedRowIds = ids.filter((id) => !groupById.has(id))

  // A group can never be dropped onto itself or onto one of its own rows.
  if (targetId !== null) {
    for (const gid of draggedGroupIds) {
      if (groupById.get(gid)!.sessionIds.includes(targetId)) return null
    }
  }

  // Detach every dragged id from wherever it sits, remembering which groups
  // had rows before so only a group emptied HERE is dropped.
  const dragged = new Set(ids)
  const hadRows = new Set(layout.groups.filter((g) => g.sessionIds.length > 0).map((g) => g.id))
  const groups: G[] = layout.groups.map((g) => ({
    ...g,
    sessionIds: g.sessionIds.filter((sid) => !dragged.has(sid))
  }))
  const byId = new Map(groups.map((g) => [g.id, g]))
  let order = layout.displayOrder.filter((id) => !dragged.has(id))

  const parentOf = (id: string): G | undefined => groups.find((g) => g.sessionIds.includes(id))
  const insertTopLevel = (
    anchor: string | null,
    where: 'before' | 'after',
    what: string[]
  ): void => {
    const idx = anchor === null ? -1 : order.indexOf(anchor)
    if (idx === -1) order.push(...what)
    else order.splice(where === 'after' ? idx + 1 : idx, 0, ...what)
  }

  const targetGroup = targetId !== null ? byId.get(targetId) : undefined
  const targetParent = targetId !== null && !targetGroup ? parentOf(targetId) : undefined

  if (targetGroup && position === 'inside') {
    targetGroup.sessionIds.push(...draggedRowIds)
    // Invariant 2: dragged groups sit beside the target, never within it.
    insertTopLevel(targetGroup.id, 'after', draggedGroupIds)
  } else if (targetParent) {
    // The target is a row inside a group: rows join it there; groups go beside
    // that group at the top level. "inside" on a row reads as "after".
    const idx = targetParent.sessionIds.indexOf(targetId!)
    targetParent.sessionIds.splice(position === 'before' ? idx : idx + 1, 0, ...draggedRowIds)
    insertTopLevel(targetParent.id, 'after', draggedGroupIds)
  } else {
    // A top-level target (group header, standalone row, file tab), the
    // explicit top level (null), or an unknown id → the top level.
    const where = position === 'before' ? 'before' : 'after'
    insertTopLevel(targetId, where, ids)
  }

  // Invariant 3: a group this move emptied goes away.
  const emptied = new Set(
    groups.filter((g) => hadRows.has(g.id) && g.sessionIds.length === 0).map((g) => g.id)
  )
  const finalGroups = groups.filter((g) => !emptied.has(g.id))
  order = order.filter((id) => !emptied.has(id))

  // Invariants 1 and 4: nothing nested surfaces at the top level, nothing
  // appears twice, every group is reachable.
  const nested = new Set<string>()
  for (const g of finalGroups) for (const sid of g.sessionIds) nested.add(sid)
  const seen = new Set<string>()
  const finalOrder: string[] = []
  for (const id of order) {
    if (nested.has(id) || seen.has(id)) continue
    seen.add(id)
    finalOrder.push(id)
  }
  for (const g of finalGroups) {
    if (!seen.has(g.id)) {
      seen.add(g.id)
      finalOrder.push(g.id)
    }
  }

  if (sameLayout(layout, { groups: finalGroups, displayOrder: finalOrder })) return null
  return { groups: finalGroups, displayOrder: finalOrder }
}

function sameLayout<G extends OpsGroup>(a: OpsLayout<G>, b: OpsLayout<G>): boolean {
  if (a.displayOrder.length !== b.displayOrder.length) return false
  if (a.displayOrder.some((id, i) => id !== b.displayOrder[i])) return false
  if (a.groups.length !== b.groups.length) return false
  return a.groups.every((g, i) => {
    const h = b.groups[i]
    return (
      g.id === h.id &&
      g.sessionIds.length === h.sessionIds.length &&
      g.sessionIds.every((sid, j) => sid === h.sessionIds[j])
    )
  })
}
