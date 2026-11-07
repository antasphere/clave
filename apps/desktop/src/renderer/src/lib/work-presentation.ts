import { deriveWorkUnits, type WorkUnitView } from '@clave/contract/work-rules'
import type { Session } from '../store/session-types'

/**
 * The sidebar's wave and lane entries (PRDCT-4123), read from the sessions'
 * own work assignments, never from their titles. One entry per unit, sitting
 * where its earliest-joined reachable member sits, so a successor opened at
 * the top of the group never moves it; every other reachable member folds
 * into it, and so do the agents the members spawned without an assignment of
 * their own. A view, never a change: no session moves, closes or changes
 * group, and the search still shows every session as its own row.
 */
export interface WorkEntry extends WorkUnitView {
  /** The member whose row the entry takes. */
  anchor: string
  /** Where a click on the entry goes: the session that holds the unit, or
   *  the one that completed it. Null when the unit is unresolved or has no
   *  holder: the entry then opens its summary instead of guessing. */
  target: string | null
  /** Agents the members spawned with no assignment of their own. Current and
   *  reachable in the entry whoever spawned them, a superseded lead included:
   *  a live worker is never history because its ancestor is. */
  agents: Session[]
}

export interface WorkPresentation {
  /** The entry each anchor row renders in place of its session. */
  entryByAnchor: Map<string, WorkEntry>
  /** Reachable member rows an entry stands for: every member but its anchor. */
  folded: Set<string>
  /** The unit of every member, reachable or not. */
  unitOf: Map<string, string>
}

/** Where a click, a digit shortcut or a range selection lands for an entry. */
export function entryTarget(entry: WorkEntry): string {
  return entry.target ?? entry.anchor
}

/**
 * The entries for the rows this sidebar would draw (`reachableIds`), with
 * the spawned agents the subagent presentation folded under each member
 * (`descendants`, keyed by the member). `editableId` is a member being
 * renamed: it keeps its own row until the edit ends, as a folded subagent does.
 */
export function workPresentation(
  sessions: readonly Session[],
  reachableIds: ReadonlySet<string>,
  descendants: ReadonlyMap<string, readonly Session[]>,
  editableId?: string | null
): WorkPresentation {
  const local = sessions.filter((s) => s.sessionType === 'local' && s.work)
  const units = deriveWorkUnits(local.map((s) => ({ id: s.id, work: s.work })))
  const entryByAnchor = new Map<string, WorkEntry>()
  const folded = new Set<string>()
  const unitOf = new Map<string, string>()
  for (const unit of units) {
    for (const id of unit.members) unitOf.set(id, unit.unit)
    const reachable = unit.members.filter((id) => reachableIds.has(id) && id !== editableId)
    if (reachable.length === 0) continue
    const [anchor, ...others] = reachable
    for (const id of others) folded.add(id)
    const target =
      unit.owner.state === 'held' || unit.owner.state === 'completed' ? unit.owner.id : null
    const agents: Session[] = []
    const seen = new Set<string>()
    for (const id of unit.members) {
      for (const agent of descendants.get(id) ?? []) {
        if (seen.has(agent.id)) continue
        seen.add(agent.id)
        agents.push(agent)
      }
    }
    entryByAnchor.set(anchor, { ...unit, anchor, target, agents })
  }
  return { entryByAnchor, folded, unitOf }
}
