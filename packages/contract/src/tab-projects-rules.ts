/**
 * Which project a tab works on (PRDCT-5179): what Jev, TypeSafe's decision
 * model, answered when a server asked it, how that answer becomes a decision,
 * and how a group reads the decisions of its tabs.
 *
 * A project is a group of the workspace's `.clave` files. The server that
 * owns a tab asks one question, a choice among those groups, with what the
 * tab said and the folders its tools touched (`src/main/decisions/`). Jev
 * answers a share per project, summing to about 1, and never prose. Clave
 * applies an answer by itself only above the floors below; under them it
 * applies nothing and shows the two nearest projects with their shares.
 *
 * The reading lives on the tab's own record, beside its `work`, so it
 * survives a restart the way the record does, and a group never keeps a link
 * of its own: its name is read from its tabs, one project giving its name and
 * several « A | B | C ».
 *
 * The floors were measured, not chosen (25 November 2026, on `jev-1.14.0`,
 * 59 labelled sessions): above 0.90 the choice answered 41 and was wrong on
 * none; 4 more were pairs that held 0.90 together and all held the right
 * project; and on a message no project fitted, the choice still named one at
 * 0.97 while the companion question said no. Change a floor only with a
 * measurement of the same kind.
 *
 * Plain TypeScript with no Effect, because the renderer imports it for the
 * sidebar; the wire schema in `tab-projects.ts` mirrors these types and
 * `tab-projects.test.ts` holds the two together.
 */

export const PROJECT_FLOORS = {
  /** The share the named projects must hold together for a tab to be decided. */
  decided: 0.9,
  /** The least share a project after the first must hold to be named with it.
   *  One project cannot hold `decided` while another holds this: a second
   *  project is named when the two hold `decided` TOGETHER (0.66 and 0.33). */
  second: 0.2,
  /** The least probability of « the work belongs to one of the listed
   *  projects »: a choice always names one, even when none fits. */
  fits: 0.7,
  /** No more projects than this are named for one tab. */
  most: 3
} as const

export interface ProjectFloors {
  readonly decided: number
  readonly second: number
  readonly fits: number
  readonly most: number
}

/** What a reading concluded: the tab works on the named projects; Jev
 *  hesitates and the two nearest are kept; or no project fits the tab. */
export const PROJECT_STATUSES = ['decided', 'undecided', 'none'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

/** The lengths a record's reading keeps (the wire schema checks them). */
export const PROJECT_LIMITS = { file: 4096, name: 255, model: 64, basis: 64, picks: 3 } as const

/** How a group's name joins several projects. */
export const PROJECT_NAME_SEPARATOR = ' | '

/** A project a tab was read on: a group of a `.clave` file, by the identity
 *  the routines use for a group (the file that declares it and its name),
 *  with the share Jev gave it. */
export interface ProjectPick {
  /** The `.clave` file that declares the group, as its server reads it. */
  file: string
  /** The group's name in that file: what a person reads. */
  name: string
  /** Its share of the choice, 0 to 1. */
  p: number
}

/** A tab's reading, as its record keeps it. */
export interface TabProjects {
  status: ProjectStatus
  /** `decided`: the projects the tab works on, the largest share first.
   *  `undecided`: the two nearest. `none`: empty. */
  picks: ProjectPick[]
  /** The probability that the work belongs to one of the listed projects. */
  fits: number
  readAt: number
  /** The model that answered, by its versioned id. */
  model: string
  /** What the reading was made on: a digest of what Jev read (what the tab
   *  said, the options, the model). The same basis is never asked twice. */
  basis: string
}

/** One option's share in a choice's answer, by the name it was sent under. */
export interface ProjectShare {
  name: string
  p: number
}

export type ChoiceReading =
  | { status: 'decided'; shares: ProjectShare[] }
  | { status: 'undecided'; shares: ProjectShare[] }
  | { status: 'none'; shares: [] }

/** Sums of shares are compared with this slack: 0.7 + 0.2 is not 0.9 in
 *  floating point. */
const SLACK = 1e-9

const isShare = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 + SLACK

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined

/**
 * A record's reading as it is read back from disk, kept only when it is
 * whole: a file written by another version, or by hand, must never put a
 * half-shaped reading in a sidebar. Nothing is coerced and nothing unknown is
 * kept (the rule of `sanitizeWork`). Pure.
 */
export function sanitizeTabProjects(value: unknown): TabProjects | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const status = PROJECT_STATUSES.find((known) => known === v.status)
  const model = text(v.model, PROJECT_LIMITS.model)
  const basis = text(v.basis, PROJECT_LIMITS.basis)
  if (!status || !model || !basis || !isShare(v.fits)) return undefined
  if (typeof v.readAt !== 'number' || !Number.isFinite(v.readAt) || v.readAt < 0) return undefined
  if (!Array.isArray(v.picks) || v.picks.length > PROJECT_LIMITS.picks) return undefined
  const picks: ProjectPick[] = []
  for (const raw of v.picks) {
    if (!raw || typeof raw !== 'object') return undefined
    const pick = raw as Record<string, unknown>
    const file = text(pick.file, PROJECT_LIMITS.file)
    const name = text(pick.name, PROJECT_LIMITS.name)
    if (!file || !name || !isShare(pick.p)) return undefined
    picks.push({ file, name, p: pick.p })
  }
  // A reading that placed the tab names a project; one that did not names none.
  if ((status === 'none') !== (picks.length === 0)) return undefined
  return { status, picks, fits: v.fits, readAt: v.readAt, model, basis }
}

/** The shares of an answer, the largest first; equal shares in the order of
 *  their names, so the same answer always reads the same. Anything that is
 *  not a share between 0 and 1 is dropped. Pure. */
export function rankShares(probabilities: Readonly<Record<string, unknown>>): ProjectShare[] {
  const shares: ProjectShare[] = []
  for (const [name, p] of Object.entries(probabilities)) {
    if (name && isShare(p)) shares.push({ name, p: Math.min(p, 1) })
  }
  return shares.sort((a, b) => b.p - a.p || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * A choice's answer read into a decision. Pure.
 *
 * - No project fits (`fits` under its floor, or no share at all): `none`.
 * - Otherwise the projects are taken from the largest share down, a project
 *   after the first only while it holds `second`, `most` at most, until they
 *   hold `decided` together: `decided`, with those projects.
 * - When they never do: `undecided`, with the two nearest.
 */
export function readProjectChoice(
  probabilities: Readonly<Record<string, unknown>>,
  fits: number,
  floors: ProjectFloors = PROJECT_FLOORS
): ChoiceReading {
  const ranked = rankShares(probabilities)
  if (ranked.length === 0 || !isShare(fits) || fits < floors.fits) {
    return { status: 'none', shares: [] }
  }
  const taken: ProjectShare[] = []
  let held = 0
  for (const share of ranked) {
    if (taken.length >= floors.most) break
    if (taken.length > 0 && share.p < floors.second) break
    taken.push(share)
    held += share.p
    if (held + SLACK >= floors.decided) return { status: 'decided', shares: taken }
  }
  return { status: 'undecided', shares: ranked.slice(0, 2) }
}

/** A project in a group's reading: its name and its mean share over the
 *  tabs that were read. */
export interface GroupProject {
  name: string
  share: number
}

export type GroupReading =
  /** Every tab that could be read is decided: the group takes this name. */
  | { status: 'named'; name: string; projects: GroupProject[] }
  /** Some tab hesitates: the group keeps its name, and these two are offered. */
  | { status: 'suggested'; nearest: GroupProject[] }
  /** Nothing to say: no tab was read, or no project fits any of them. */
  | { status: 'unread' }

/**
 * What a group reads from its tabs. Pure.
 *
 * A tab with no reading, or that no project fits, is left out. When every
 * tab left is decided, the group is named after their projects, in the order
 * of their mean share (a project a tab does not name counts for nothing in
 * that tab). When one hesitates, the group is not named: the two projects
 * with the largest mean share are offered instead. Projects are told apart
 * by name: groups sharing a name are never options.
 */
export function readGroupProjects(
  tabs: ReadonlyArray<TabProjects | null | undefined>
): GroupReading {
  const read = tabs.filter(
    (tab): tab is TabProjects => !!tab && tab.status !== 'none' && tab.picks.length > 0
  )
  if (read.length === 0) return { status: 'unread' }
  const totals = new Map<string, number>()
  for (const tab of read) {
    for (const pick of tab.picks) {
      if (!pick.name || !isShare(pick.p)) continue
      totals.set(pick.name, (totals.get(pick.name) ?? 0) + pick.p)
    }
  }
  const projects: GroupProject[] = [...totals.entries()]
    .map(([name, total]) => ({ name, share: total / read.length }))
    .sort((a, b) => b.share - a.share || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (projects.length === 0) return { status: 'unread' }
  if (read.every((tab) => tab.status === 'decided')) {
    return {
      status: 'named',
      name: projects.map((project) => project.name).join(PROJECT_NAME_SEPARATOR),
      projects
    }
  }
  return { status: 'suggested', nearest: projects.slice(0, 2) }
}

/** A share as a person reads it: « 63% ». */
export function sharePercent(share: number): string {
  return `${Math.round(Math.max(0, Math.min(1, share)) * 100)}%`
}
