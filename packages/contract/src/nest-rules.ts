/**
 * Which tab a tab is nested under (PRDCT-4997).
 *
 * A session's record keeps the id of the tab it is nested under (`spawnedBy`):
 * the sidebar folds it under that tab, whose row counts it and unfolds to
 * show it. Until this module the link was written once, when an agent opened
 * a tab with `attachToParent`. It can now be set and cleared on a tab that
 * exists, by a person (a drag onto a row, a menu entry) or by an agent
 * (`clave_attach_session`), through the server's `NestSession`.
 *
 * The rule is plain TypeScript with no Effect, as `work-rules.ts` is, because
 * the renderer imports it: the sidebar asks it which rows a dragged tab may
 * be dropped onto, and the server refuses a command in the same words. It
 * decides nothing about where a row sits (whoever nests a tab places it
 * beside its parent in the layout) and nothing about messages: "parent" in
 * the agent tools stays the tab that opened it.
 *
 * Nothing is repaired here. A record that already points at a tab that is
 * gone, or into a loop, is read as it is: the sidebar draws such a tab as a
 * row of its own (`subagent-presentation.ts`), and taking it out clears it.
 */

/** A session as the rule reads it. */
export interface NestRecord {
  id: string
  /** The tab it is nested under now: the record's `spawnedBy`. */
  under?: string | null
  /** The workspace the tab belongs to. */
  workspaceId?: string | null
  /** The window that holds the tab: the record's `windowKey`. */
  windowKey?: string | null
  /** A session that is no tab of the sidebar: a group's terminal, the
   *  server behind a tab's page, a toolbar's (its record carries a `link`). */
  hidden?: boolean
  /** The wave or lane it works on, when it has an assignment (PRDCT-4123):
   *  that entry shows it, so it is never folded under a tab. */
  work?: { label: string; kind: string } | null
}

/** What a nesting did. */
export interface NestResult {
  id: string
  /** The tab it is nested under from now on, or null: a row of its own. */
  under: string | null
  /** False when the record already said so: nothing to write or to tell. */
  changed: boolean
}

/** A nesting the records refuse, in words an agent or a person can act on. */
export class NestRefusal extends Error {
  override readonly name = 'NestRefusal'
}

/** The nesting names a session no record and no running session knows. A
 *  plain class, as `WorkSessionUnknown` is: the server answers it as its
 *  declared not-found. */
export class NestSessionUnknown extends Error {
  override readonly name = 'NestSessionUnknown'
}

const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? null) === (b ?? null)

/**
 * Why `id` cannot be nested under `under`, or null when it can. Both must be
 * known to `all`; `under` null (take it out) is never refused. The order is
 * the order a person would be told: what the tab is, where it lives, then
 * what the move would do to the tree.
 */
export function nestRefusal(
  all: ReadonlyArray<NestRecord>,
  id: string,
  under: string | null
): string | null {
  if (under === null) return null
  if (under === id) return 'A tab cannot be nested under itself'
  const byId = new Map(all.map((r) => [r.id, r]))
  const subject = byId.get(id)
  const target = byId.get(under)
  if (!subject || !target) return null
  if (subject.hidden) return 'This session is not a tab of the sidebar: only a tab can be nested'
  if (target.hidden)
    return 'That session is not a tab of the sidebar: a tab is nested under another tab'
  if (subject.work)
    return `This tab works on the ${subject.work.kind} "${subject.work.label}", whose entry shows it. Take it out of the ${subject.work.kind} first (clave_set_work with action: "leave"), then nest it`
  if (!same(subject.workspaceId, target.workspaceId))
    return 'The two tabs are in different workspaces: a tab is nested under a tab of its own workspace'
  if (!same(subject.windowKey, target.windowKey))
    return 'The two tabs are in different windows: move the tab into the other window first, then nest it'
  // The target must not sit under the subject already, however deep. A loop
  // that is already on the records ends the walk without a verdict of its own.
  const seen = new Set<string>([under])
  let above = target.under ?? null
  while (above && !seen.has(above)) {
    if (above === id)
      return 'That tab is nested under this one: take it out first, or nest this tab under another'
    seen.add(above)
    above = byId.get(above)?.under ?? null
  }
  return null
}

/**
 * Nest the session `id` under `under`, or take it out with null, against
 * every record that exists. Answers what to write; throws `NestSessionUnknown`
 * for an id nobody knows and `NestRefusal` when the rule says no. Pure: the
 * caller writes the record and tells the windows.
 */
export function applyNest(
  all: ReadonlyArray<NestRecord>,
  id: string,
  under: string | null
): NestResult {
  const subject = all.find((r) => r.id === id)
  if (!subject) throw new NestSessionUnknown(`No session with id "${id}"`)
  if (under !== null && under !== id && !all.some((r) => r.id === under))
    throw new NestSessionUnknown(`No session with id "${under}"`)
  const refusal = nestRefusal(all, id, under)
  if (refusal) throw new NestRefusal(refusal)
  return { id, under, changed: !same(subject.under, under) }
}

/**
 * The tabs shown under `id`: every session whose links lead up to it, the
 * nearest first. What moves with a tab when it is nested, dragged or closed
 * over; a loop on the records contributes nothing.
 */
export function nestedUnder(all: ReadonlyArray<NestRecord>, id: string): string[] {
  const children = new Map<string, string[]>()
  for (const r of all) {
    if (!r.under || r.under === r.id) continue
    const list = children.get(r.under) ?? []
    list.push(r.id)
    children.set(r.under, list)
  }
  const out: string[] = []
  const seen = new Set<string>([id])
  let level = children.get(id) ?? []
  while (level.length) {
    const next: string[] = []
    for (const child of level) {
      if (seen.has(child)) continue
      seen.add(child)
      out.push(child)
      next.push(...(children.get(child) ?? []))
    }
    level = next
  }
  return out
}
