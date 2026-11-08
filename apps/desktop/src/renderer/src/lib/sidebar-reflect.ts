/**
 * What a change the SERVER made does to a layout, applied the same way to
 * the window's working copy and to the base its next merge reasons from
 * (PRDCT-3241, verifier round 2): a tab the shell moved away leaves the
 * order, its group and the terminal that ran it; a group the shell moved
 * away whole leaves, and the linked tabs that stayed become plain rows.
 * Pure, so vitest pins that the two sides agree; the store applies one of
 * these to its state and the same one to the parsed base, so a pending edit
 * (a rename not yet saved) stays a difference between the two and is saved,
 * while the reflected change itself is not.
 */
export interface ReflectGroup {
  id: string
  sessionIds: string[]
  terminals: { sessionId: string | null }[]
}

export interface ReflectLayout<G extends ReflectGroup> {
  groups: G[]
  displayOrder: string[]
}

/** The session is gone from this window: out of the order, out of every
 *  group, a terminal that ran it detached. */
export function withoutSession<G extends ReflectGroup>(
  layout: ReflectLayout<G>,
  sessionId: string
): ReflectLayout<G> {
  return {
    groups: layout.groups.map((g) => ({
      ...g,
      sessionIds: g.sessionIds.filter((sid) => sid !== sessionId),
      terminals: g.terminals.map((t) => (t.sessionId === sessionId ? { ...t, sessionId: null } : t))
    })),
    displayOrder: layout.displayOrder.filter((id) => id !== sessionId)
  }
}

/** The group is gone from this window whole; `stayed` are the linked tabs
 *  that could not move and become plain rows, appended when not placed. */
export function withoutGroup<G extends ReflectGroup>(
  layout: ReflectLayout<G>,
  groupId: string,
  stayed: string[]
): ReflectLayout<G> {
  const order = layout.displayOrder.filter((id) => id !== groupId)
  return {
    groups: layout.groups.filter((g) => g.id !== groupId),
    displayOrder: [...order, ...stayed.filter((sid) => !order.includes(sid))]
  }
}
