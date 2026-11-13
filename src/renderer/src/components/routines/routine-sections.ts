import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import { RUNS_EVERYWHERE } from '@clave/contract/server-name'
import type { RoutineBadge, RoutineBadgeState } from './routine-badge'
import { routineBadge } from './routine-badge'
import type { RoutineSurface } from './routine-servers'

/**
 * The one Routines button and its popover (PRDCT-4244): the active
 * workspace's routines in sections, one per machine, so a reader sees at
 * once what runs where. The rule the sections make visible: a routine
 * lives in one workspace and runs on one machine, or on every machine, in
 * which case it appears under each machine that lists it, the same name
 * twice. A routine placed on a machine this Mac cannot reach gets a section
 * of its own, titled by the placement and marked away or unknown. Pure:
 * the toolbar renders what this decides.
 */
export type SectionKind = 'here' | 'server' | 'away' | 'absent' | 'unknown'

export interface RoutineSection {
  /** Stable across renders: the server id, or the placement for an away section. */
  id: string
  kind: SectionKind
  /** The machine's name as the toolbar shows it. */
  title: string
  /** What is wrong, under the title; null when the machine runs its routines. */
  note: string | null
  /** The server the acts go to; LOCAL_SERVER_ID for this Mac and for an away section. */
  serverId: string
  /** Whether a routine may be created on this machine from here. */
  canCreate: boolean
  surfaces: RoutineSurface[]
}

/** Who answers to a surface's machine name, for the section's key. */
const sectionIdOf = (s: RoutineSurface): string =>
  s.runsOn === 'here'
    ? LOCAL_SERVER_ID
    : s.reachable
      ? s.serverId
      : `away:${(s.placement ?? '').toLowerCase()}`

export function sectionsOf(
  surfaces: ReadonlyArray<RoutineSurface>,
  localName = 'This Mac'
): RoutineSection[] {
  const byId = new Map<string, RoutineSection>()
  for (const s of surfaces) {
    const id = sectionIdOf(s)
    let section = byId.get(id)
    if (!section) {
      const kind: SectionKind =
        s.runsOn === 'here'
          ? 'here'
          : s.reachable
            ? 'server'
            : s.problem === 'unknown'
              ? 'unknown'
              : s.problem === 'absent'
                ? 'absent'
                : 'away'
      section = {
        id,
        kind,
        title: kind === 'here' ? localName : s.serverName,
        note:
          kind === 'away'
            ? 'Not connected'
            : kind === 'absent'
              ? 'Does not read this file'
              : kind === 'unknown'
                ? 'No machine by that name'
                : null,
        serverId: s.reachable ? s.serverId : LOCAL_SERVER_ID,
        canCreate: kind === 'here' || kind === 'server',
        surfaces: []
      }
      byId.set(id, section)
    }
    section.surfaces.push(s)
  }
  const order: Record<SectionKind, number> = { here: 0, server: 1, away: 2, absent: 3, unknown: 4 }
  return [...byId.values()].sort(
    (a, b) => order[a.kind] - order[b.kind] || a.title.localeCompare(b.title)
  )
}

/** The badge the one button carries: the strongest signal across every
 *  routine shown. Motion first (a run in flight), then the states that ask
 *  for a look, from the worst; a check once every unseen run is ok; nothing
 *  when every run was seen or none ran. */
const WEIGHT: Record<RoutineBadgeState, number> = {
  running: 9,
  waiting: 8,
  failed: 7,
  invalid: 6,
  unreachable: 5,
  attention: 4,
  ok: 3,
  seen: 1,
  never: 0
}

export function aggregateBadge(surfaces: ReadonlyArray<RoutineSurface>): RoutineBadge {
  let best: RoutineBadge = { state: 'never', working: false, dot: null }
  for (const s of surfaces) {
    const badge = routineBadge(s.view, s)
    if (WEIGHT[badge.state] > WEIGHT[best.state]) best = badge
  }
  return best
}

/** Whether a surface runs on every machine: shown under each, the same name twice. */
export const runsEverywhere = (s: Pick<RoutineSurface, 'placement'>): boolean =>
  (s.placement ?? '').toLowerCase() === RUNS_EVERYWHERE
