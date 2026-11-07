/** The order of a workspace list (#257). A registry IS its order: the toolbar
 *  switcher, Settings and the next/previous shortcuts all read the list as it
 *  is stored, so reordering means writing the same entries in a new order. */

export type DropPosition = 'before' | 'after'

/** `list` with `id` moved before or after `targetId`. The same array when the
 *  move changes nothing, or when either entry is missing. */
export function moveInList<T extends { id: string }>(
  list: readonly T[],
  id: string,
  targetId: string,
  position: DropPosition
): readonly T[] {
  if (id === targetId) return list
  const from = list.findIndex((w) => w.id === id)
  if (from < 0 || !list.some((w) => w.id === targetId)) return list
  const rest = list.filter((w) => w.id !== id)
  const at = rest.findIndex((w) => w.id === targetId) + (position === 'after' ? 1 : 0)
  if (at === from) return list
  return [...rest.slice(0, at), list[from], ...rest.slice(at)]
}

/** `list` in the order `ids` names. An entry `ids` does not name keeps its
 *  place relative to the named ones that preceded it, and an id the list does
 *  not hold is ignored: a registry another writer changed since `ids` was
 *  read loses nothing and gains nothing. */
export function orderByIds<T extends { id: string }>(
  list: readonly T[],
  ids: readonly string[]
): T[] {
  const byId = new Map(list.map((w) => [w.id, w]))
  const named = ids.filter((id, i) => byId.has(id) && ids.indexOf(id) === i)
  const queue = named.map((id) => byId.get(id)!)
  const isNamed = new Set(named)
  const out: T[] = []
  for (const w of list) {
    // The named entries fill the named slots in their new order; an unnamed
    // entry stays where it was among them.
    out.push(isNamed.has(w.id) ? queue.shift()! : w)
  }
  return out
}
