/**
 * Does a session's history belong to a group? By id OR by name: group ids
 * are minted at every launch (a pinned group relaunched tomorrow has a new
 * one), and the name is how the user thinks of the group. ONE definition,
 * shared by the main process (the fold) and the renderer (the dialog's chip
 * filter) — a second hand-written copy of this rule drifts silently.
 */
export interface GroupRef {
  id: string
  name: string
}

export function entryInGroup(groups: readonly GroupRef[], group: GroupRef): boolean {
  return groups.some((g) => g.id === group.id || (g.name !== '' && g.name === group.name))
}
