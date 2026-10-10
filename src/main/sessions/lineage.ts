/**
 * Which tab opened which (wave 4, PRDCT-3377): the parent link an agent
 * needs to answer "parent" in `clave_send_to_session` and
 * `clave_read_session`, and the relationship the reach rule reads. Kept in
 * the memory of the process that serves the tools, as the window kept it
 * in its store: set when an agent's served `clave_open_session` starts a
 * tab, forgotten when the tab's process ends, never persisted, so the link
 * does not survive a restart (the message the tools answer says so).
 */
const parents = new Map<string, string>()

export function setParent(childId: string, parentId: string): void {
  parents.set(childId, parentId)
}

/** The tab that opened this one, or null. */
export function parentOf(childId: string): string | null {
  return parents.get(childId) ?? null
}

/** The tabs this one opened. */
export function childrenOf(parentId: string): string[] {
  return [...parents].filter(([, parent]) => parent === parentId).map(([child]) => child)
}

export function forgetLineage(id: string): void {
  parents.delete(id)
}

/** Tests only. */
export function resetLineageForTests(): void {
  parents.clear()
}
