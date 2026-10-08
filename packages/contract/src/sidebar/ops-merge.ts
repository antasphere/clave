/**
 * The pure sidebar-layout merges (PRDCT-1703), kept pure so vitest pins
 * them: how this window's layout read from its own file is merged into the
 * store at boot (`mergeLayoutForKeys`), and how groups handed over by
 * another window — a closing window's sidebar, a group moved here — are
 * taken in (`absorbLayout`).
 */
export interface LayoutGroupLike {
  id: string
  sessionIds: string[]
  terminals: { sessionId: string | null }[]
  workspaceId?: string
}

export interface LayoutSessionLike {
  id: string
  workspaceId?: string
  view?: { serverSessionId?: string | null } | null
}

export interface LayoutSlice<G extends LayoutGroupLike> {
  groups: G[]
  displayOrder: string[]
}

export type LayoutKey = string | null

/**
 * Replace the partitions of `keys` in the store with `persisted` (those
 * workspaces' layouts as read from their files), pruned to `surviving`
 * sessions, and leave every other workspace's groups and order untouched.
 *
 * `surviving` is every session that still EXISTS for those workspaces — in
 * this store, live in another window, or a record on disk — not merely the
 * ones this window holds: a group whose members live elsewhere is kept as a
 * shell (its rows render nothing here), because pruning it would rewrite the
 * file without it the moment this window persists. Only a session that is
 * gone everywhere prunes its group, exactly as boot restore does.
 *
 * The same shape the boot restore uses: every group of those workspaces comes
 * back, members pruned to the survivors (an emptied group is a group, see
 * below), a terminal whose session is gone is detached, the persisted order is
 * kept minus dead references, surviving standalone sessions of those
 * workspaces the order missed are appended, then kept groups not yet placed.
 * Ids nested inside a kept group (a member, a group terminal, a session view's
 * hidden server) never surface at the top level.
 *
 * A group with no members left is KEPT, not pruned. Closing the last tab of a
 * group used to make the group vanish with it — the user opens a group,
 * closes its one session, and cannot find the group again — so an empty group
 * is now a normal state: the sidebar draws it as a card holding a "No
 * sessions" row, and only Delete / Ungroup take it away. (Before that, a
 * group survived on a running quick-launch terminal alone, PRDCT-1756; it
 * still does, as a special case of surviving on nothing.)
 */
export function mergeLayoutForKeys<G extends LayoutGroupLike>(
  state: { groups: G[]; displayOrder: string[]; sessions: LayoutSessionLike[] },
  keys: LayoutKey[],
  persisted: LayoutSlice<G>,
  surviving: Iterable<string>
): { groups: G[]; displayOrder: string[] } {
  const keySet = new Set<LayoutKey>(keys)
  const alive = new Set(surviving)
  // Ownership is by EXPLICIT stamp; an unstamped item belongs to the unscoped
  // (null) partition only, never to a string workspace being taken. This is
  // the asymmetry with the WRITE path (partitionSidebarLayout routes an
  // unstamped group to the window's workspace): a TAKE must never claim — and
  // then drop from an empty file — an unstamped group that has not been
  // stamped yet. Taking one workspace's layout leaves unstamped groups (and
  // every other workspace's) exactly where they are; only when the NULL key
  // itself is merged (no-workspace mode boot) does an unstamped group belong
  // to it. (Regression guard for the first-workspace F1: registering the
  // first workspace no longer routes the still-unstamped groups through the
  // empty new file.)
  const ownsGroup = (g: G): boolean => keySet.has(g.workspaceId ?? null)
  const sessionKey = new Map<string, LayoutKey>()
  for (const s of state.sessions) sessionKey.set(s.id, s.workspaceId ?? null)

  // Everything of OTHER workspaces stays exactly where it is.
  const others = state.groups.filter((g) => !ownsGroup(g))
  const otherGroupIds = new Set(others.map((g) => g.id))

  const kept: G[] = []
  for (const g of persisted.groups ?? []) {
    // One object per group id. An unstamped in-memory group is written to the
    // window's workspace file (partitionSidebarLayout's fallback) yet stays in
    // `others` on a take (ownership is by explicit stamp), so the file's copy
    // would otherwise come back beside the live one — two groups with one id,
    // and every by-id lookup editing the wrong half. The live copy wins.
    if (otherGroupIds.has(g.id)) continue
    const sessionIds = (g.sessionIds ?? []).filter((sid) => alive.has(sid))
    const terminals = (g.terminals ?? []).map((t) =>
      t.sessionId && !alive.has(t.sessionId) ? { ...t, sessionId: null } : t
    )
    // Never pruned for being empty: see the doc comment. (Members-only was
    // once the rule, and it is what put a live `npm run dev` in the sidebar as
    // a mystery tab, PRDCT-1756 — the group it belonged to was pruned for
    // having no surviving member, and pruning it un-nested its terminal.)
    kept.push({ ...g, sessionIds, terminals })
  }
  // A group BORN during this boot, before the saved layout came back (an
  // agent's createGroup in the first seconds, PRDCT-1762): it is in the
  // store and in no file, and replacing the partition would wipe it. It is
  // kept where the store placed it; the save that follows the restore
  // writes it to the server like any other.
  const born: G[] = []
  const persistedIds = new Set((persisted.groups ?? []).map((g) => g.id))
  for (const g of state.groups) {
    if (ownsGroup(g) && !persistedIds.has(g.id) && !otherGroupIds.has(g.id)) {
      born.push(g)
      kept.push(g)
    }
  }
  const bornIds = new Set(born.map((g) => g.id))
  const keptIds = new Set(kept.map((g) => g.id))

  const nested = new Set<string>()
  for (const g of kept) {
    for (const sid of g.sessionIds) nested.add(sid)
    for (const t of g.terminals) if (t.sessionId) nested.add(t.sessionId)
  }
  for (const s of state.sessions) {
    if (s.view?.serverSessionId) nested.add(s.view.serverSessionId)
  }

  const order: string[] = []
  const seen = new Set<string>()
  const push = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    order.push(id)
  }
  // Other workspaces' entries keep their positions; this window's entries of
  // the merged keys are rebuilt below. An id that names nothing known is
  // stale and dropped.
  for (const id of state.displayOrder) {
    if (otherGroupIds.has(id)) push(id)
    else if (bornIds.has(id)) push(id)
    else if (sessionKey.has(id) && !keySet.has(sessionKey.get(id)!)) push(id)
    else if (!sessionKey.has(id) && !keySet.size) push(id)
  }
  for (const id of persisted.displayOrder ?? []) {
    if (keptIds.has(id)) push(id)
    else if (alive.has(id) && !nested.has(id)) push(id)
  }
  for (const s of state.sessions) {
    if (keySet.has(sessionKey.get(s.id)!) && !nested.has(s.id)) push(s.id)
  }
  for (const g of kept) push(g.id)

  return { groups: [...others, ...kept], displayOrder: order }
}

/**
 * Append what another window handed over: groups not already in the store
 * (by id) and top-level order entries not already placed, in the incoming
 * order. Known groups and entries are left exactly where they are, and an id
 * nested inside a kept group never surfaces at the top level. The members
 * themselves arrive through adoption (addSession), which places a session
 * whose group already holds it.
 */
export function absorbLayout<G extends LayoutGroupLike>(
  state: { groups: G[]; displayOrder: string[] },
  incoming: { groups?: G[]; displayOrder?: string[] }
): { groups: G[]; displayOrder: string[] } {
  const known = new Set(state.groups.map((g) => g.id))
  const groups = [...state.groups]
  for (const g of incoming.groups ?? []) {
    if (!g || typeof g.id !== 'string' || known.has(g.id)) continue
    known.add(g.id)
    groups.push({
      ...g,
      sessionIds: Array.isArray(g.sessionIds) ? g.sessionIds : [],
      terminals: Array.isArray(g.terminals) ? g.terminals : []
    })
  }
  const nested = new Set<string>()
  for (const g of groups) {
    for (const sid of g.sessionIds) nested.add(sid)
    for (const t of g.terminals) if (t.sessionId) nested.add(t.sessionId)
  }
  const placed = new Set(state.displayOrder)
  const displayOrder = [...state.displayOrder]
  for (const id of incoming.displayOrder ?? []) {
    if (typeof id !== 'string' || placed.has(id) || nested.has(id)) continue
    placed.add(id)
    displayOrder.push(id)
  }
  return { groups, displayOrder }
}

/**
 * Where an ADOPTED session goes in the sidebar — a survivor at boot, a tab
 * handed over by another window. Placement-neutral by design: an adoption
 * never nests a tab into a group it was not in (the fresh-spawn heuristic
 * that nests into the selected group must not apply — a moved tab would be
 * swallowed by whatever the target window has selected) and never puts it
 * at the top level when something already holds it (a group's members, a
 * group's quick-launch terminal, a session view's hidden server) — that
 * would show one tab twice. Returns the new top-level order.
 */
export function placeAdopted<G extends LayoutGroupLike>(
  state: { groups: G[]; displayOrder: string[]; sessions: LayoutSessionLike[] },
  sessionId: string
): string[] {
  if (state.displayOrder.includes(sessionId)) return state.displayOrder
  for (const g of state.groups) {
    if (g.sessionIds.includes(sessionId)) return state.displayOrder
    if (g.terminals.some((t) => t.sessionId === sessionId)) return state.displayOrder
  }
  if (state.sessions.some((s) => s.view?.serverSessionId === sessionId)) return state.displayOrder
  return [...state.displayOrder, sessionId]
}

export interface MergeGroupLike extends LayoutGroupLike {
  name: string
}

export interface MergeResult<G extends MergeGroupLike> {
  groups: G[]
  displayOrder: string[]
  /** The groups whose local change could not be kept: the server removed
   *  them while the window changed them (beyond letting members go). The
   *  window tells the person. */
  dropped: { id: string; name: string }[]
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Whether `mine` differs from `was` only by members that left and terminal
 *  links that went null: what a tab moving away, a session closing or a
 *  hand-over does to a group, never an edit worth keeping on its own. */
function onlyShrank<G extends MergeGroupLike>(was: G, mine: G): boolean {
  const keys = new Set([...Object.keys(was), ...Object.keys(mine)])
  for (const key of keys) {
    if (key === 'sessionIds' || key === 'terminals') continue
    if (!sameJson((was as Record<string, unknown>)[key], (mine as Record<string, unknown>)[key]))
      return false
  }
  const wasMembers = new Set(was.sessionIds)
  if (!mine.sessionIds.every((sid) => wasMembers.has(sid))) return false
  if (mine.terminals.length !== was.terminals.length) return false
  return mine.terminals.every((t, i) => {
    const before = was.terminals[i] as { sessionId: string | null } & Record<string, unknown>
    const after = t as { sessionId: string | null } & Record<string, unknown>
    const { sessionId: s1, ...restBefore } = before
    const { sessionId: s2, ...restAfter } = after
    return sameJson(restBefore, restAfter) && (s2 === s1 || s2 === null)
  })
}

/** A group both touched: every field the window changed against `base`
 *  takes the window's value, every other field the server's, so a rename
 *  made elsewhere and a member added here both survive. */
function mergeGroup<G extends MergeGroupLike>(was: G, mine: G, theirs: G): G {
  const out = { ...theirs } as Record<string, unknown>
  const w = was as Record<string, unknown>
  const m = mine as Record<string, unknown>
  for (const key of new Set([...Object.keys(w), ...Object.keys(m)])) {
    if (!sameJson(w[key], m[key])) {
      if (m[key] === undefined) delete out[key]
      else out[key] = m[key]
    }
  }
  return out as G
}

/**
 * A window's pending change re-applied over the server's fresh snapshot,
 * when its whole-layout save was refused or a push landed while it edited
 * (PRDCT-3241, the wave's ruling of 7 October). Three layouts: `base`, what
 * the window last knew the server held (the layout it last saved or
 * applied); `local`, the window's working copy; `server`, the snapshot the
 * server holds now. Only what the window CHANGED against `base` is
 * re-applied; everything else is the server's, so an idle window (local
 * equals base) yields the server's layout untouched and a reorder or a
 * placement made elsewhere stands. The rules:
 *
 *   - a group the window added (not in `base`) is added, at the place the
 *     window gave it;
 *   - a group the window removed (in `base`, not in `local`) is removed;
 *   - a group the window changed: field by field, the window's value where
 *     it changed the field, the server's elsewhere; when the server removed
 *     the group meanwhile, the edit is dropped and reported, unless the
 *     window only let members go (a tab moved or closed), which is no edit;
 *   - a group the window left alone is the server's, gone if the server
 *     removed it;
 *   - the order is the server's; the window's additions enter after their
 *     local predecessor; the window's removals leave; when the window
 *     REORDERED (its order of the entries both knew differs from base's),
 *     the window's sequence of those entries wins; nothing nested surfaces.
 */
export function mergeLayouts<G extends MergeGroupLike>(
  base: LayoutSlice<G>,
  local: LayoutSlice<G>,
  server: LayoutSlice<G>
): MergeResult<G> {
  const byId = (groups: G[]): Map<string, G> => new Map(groups.map((g) => [g.id, g]))
  const baseGroups = byId(base.groups)
  const localGroups = byId(local.groups)
  const serverGroups = byId(server.groups)
  const dropped: { id: string; name: string }[] = []
  const groups: G[] = []
  const placedGroup = new Set<string>()

  for (const g of server.groups) {
    const was = baseGroups.get(g.id)
    const mine = localGroups.get(g.id)
    if (was && !mine) continue // the window removed it
    if (mine && !was)
      groups.push(mine) // the window added it; the server has one too: the window's
    else if (mine && was && !sameJson(mine, was)) groups.push(mergeGroup(was, mine, g))
    else groups.push(g)
    placedGroup.add(g.id)
  }
  for (const g of local.groups) {
    if (placedGroup.has(g.id)) continue
    const was = baseGroups.get(g.id)
    if (!was) {
      groups.push(g)
      placedGroup.add(g.id)
    } else if (!sameJson(g, was) && !onlyShrank(was, g)) dropped.push({ id: g.id, name: g.name })
  }

  const nested = new Set<string>()
  for (const g of groups) {
    for (const sid of g.sessionIds) nested.add(sid)
    for (const t of g.terminals) if (t.sessionId) nested.add(t.sessionId)
  }
  const groupIds = new Set(groups.map((g) => g.id))
  const isGroupId = (id: string): boolean =>
    baseGroups.has(id) || localGroups.has(id) || serverGroups.has(id)
  const exists = (id: string): boolean => !nested.has(id) && (!isGroupId(id) || groupIds.has(id))
  const baseOrder = new Set(base.displayOrder)
  const localOrder = new Set(local.displayOrder)
  const serverOrder = new Set(server.displayOrder)

  // The sequence of entries the window and the base both knew: when the
  // window changed it, the window reordered.
  const known = (ids: string[]): string[] =>
    ids.filter((id) => baseOrder.has(id) && localOrder.has(id))
  const reordered = !sameJson(known(local.displayOrder), known(base.displayOrder))

  // The server's order, as the spine; the window's sequence over the common
  // entries when the window reordered.
  let spine = server.displayOrder.filter((id) => !(baseOrder.has(id) && !localOrder.has(id))) // minus the window's removals
  if (reordered) {
    const common = new Set(local.displayOrder.filter((id) => serverOrder.has(id)))
    const mineSeq = local.displayOrder.filter((id) => common.has(id))
    let k = 0
    spine = spine.map((id) => (common.has(id) ? mineSeq[k++] : id))
  }
  // The window's additions, after their local predecessor.
  for (let i = 0; i < local.displayOrder.length; i++) {
    const id = local.displayOrder[i]
    if (baseOrder.has(id) || spine.includes(id)) continue
    const before = local.displayOrder[i - 1]
    const at = before === undefined ? -1 : spine.indexOf(before)
    if (at === -1) spine.unshift(id)
    else spine.splice(at + 1, 0, id)
  }

  const seen = new Set<string>()
  const displayOrder: string[] = []
  for (const id of spine) {
    if (seen.has(id) || !exists(id)) continue
    seen.add(id)
    displayOrder.push(id)
  }
  for (const g of groups) {
    if (seen.has(g.id)) continue
    seen.add(g.id)
    displayOrder.push(g.id)
  }
  return { groups, displayOrder, dropped }
}
