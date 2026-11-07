/**
 * The "same group" leg of the cross-tab reach rule (`assertCanReach`, both the
 * served road and the window's): two sessions share a group when the group
 * counts both among its members, and its members are its tabs AND the live
 * sessions of its quick-launch terminals. A group terminal is the group's own
 * dev server, so a tab of the group reads its logs (PRDCT-3420); sending to it
 * stays refused by the plain-terminal guard, not by this rule. Pure, so one
 * test pins it for both roads.
 */
export interface ReachGroupLike {
  sessionIds: ReadonlyArray<string>
  terminals: ReadonlyArray<{ sessionId: string | null }>
}

const isMember = (g: ReachGroupLike, id: string): boolean =>
  g.sessionIds.includes(id) || g.terminals.some((t) => t.sessionId === id)

export function shareAGroup(groups: ReadonlyArray<ReachGroupLike>, a: string, b: string): boolean {
  return groups.some((g) => isMember(g, a) && isMember(g, b))
}
