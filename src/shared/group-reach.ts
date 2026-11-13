/**
 * The "same group" leg of the relation between two tabs (`isRelated` /
 * `canReach`, both the served road and the window's): two sessions share a
 * group when the group counts both among its members, and its members are its
 * tabs AND the live sessions of its quick-launch terminals. Since PRDCT-4236
 * it limits nothing (any tab may be reached); it only breaks the tie when
 * several tabs share the name a call targets. Pure, so one test pins it for
 * both roads.
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
