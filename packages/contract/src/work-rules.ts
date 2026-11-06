/**
 * Which work a session does (PRDCT-4123): the wave or the lane it belongs to,
 * its role there, and whether it holds that role now. A wave on Exos runs
 * several lanes, each a chain of sessions that build, hand over and verify;
 * the sidebar used to show one row per process, and the human read titles to
 * find who held a lane. The assignment is what replaces the reading.
 *
 * The assignment lives on the session's own record, beside its name and its
 * parent, so it survives a restart, a restore from the records and an account
 * switch the way the record does. Clave never invents a work unit: whoever
 * assigns names it by a stable key (an Exos workstream stem, a run and lane
 * id) and gives it a short label, and Clave stores the association and derives
 * the entries from it. A session with no assignment is an ordinary session.
 *
 * The words are the shared agent workflow's (agents-kb, lllane's record
 * contract): a role is held by one session at a time when it is exclusive, a
 * successor is `pending` until it takes over, a predecessor it replaces is
 * `superseded`, and an assignment that ended normally is `completed`. `unresolved` is never
 * stored: it is what the derivation says when the records disagree, and an
 * owner is never picked by time or by title.
 *
 * Plain TypeScript with no Effect, because the renderer imports it for the
 * sidebar; the wire schema in `work.ts` mirrors these types and `work.test.ts`
 * holds the two together.
 */

export const WORK_KINDS = ['wave', 'lane'] as const
export type WorkKind = (typeof WORK_KINDS)[number]

export const WORK_ROLES = ['coordinator', 'lead', 'verifier', 'worker'] as const
export type WorkRole = (typeof WORK_ROLES)[number]

export const WORK_STANDINGS = ['current', 'pending', 'superseded', 'completed'] as const
export type WorkStanding = (typeof WORK_STANDINGS)[number]

/** The roles one session at a time holds in a unit. Workers are many, each
 *  on its own bounded task. */
export const EXCLUSIVE_ROLES: ReadonlySet<WorkRole> = new Set<WorkRole>([
  'coordinator',
  'lead',
  'verifier'
])

/** The role that holds a unit: a wave's coordinator, a lane's lead. */
export type OwnerRole = 'coordinator' | 'lead'
export function ownerRoleOf(kind: WorkKind): OwnerRole {
  return kind === 'wave' ? 'coordinator' : 'lead'
}

/** The roles a unit of this kind takes: a lane has no coordinator and a wave
 *  no lead. */
export function roleFitsKind(role: WorkRole, kind: WorkKind): boolean {
  if (role === 'coordinator') return kind === 'wave'
  if (role === 'lead') return kind === 'lane'
  return true
}

export interface WorkAssignment {
  /** The work unit's stable key, chosen by whoever assigns. */
  unit: string
  kind: WorkKind
  /** The unit's short result label, as its sidebar entry shows it. */
  label: string
  /** A lane's wave: its key and its label, the entry's breadcrumb. */
  wave?: string
  waveLabel?: string
  role: WorkRole
  /** A worker's bounded task, when several workers share the role. */
  task?: string
  standing: WorkStanding
  /** When the session joined this unit (epoch ms). The entry sits where its
   *  earliest-joined member sits, so a successor never moves it. */
  joinedAt: number
  /** When the standing last changed (epoch ms). */
  since: number
  /** The session this one took the role over from, or is taking it over
   *  from while `pending`. The handover's one link: who handed over to whom
   *  is read off the successor. */
  from?: string
}

export const WORK_LIMITS = { unit: 200, label: 80, task: 80 } as const

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** A session id as the records spell it: a lowercase or uppercase UUID. */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value)
}

/** A text field as an assignment keeps it: trimmed, within its length, with
 *  no control character; anything else is not a value. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max || CONTROL.test(trimmed)) return undefined
  return trimmed
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

function stamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * The assignment a record carries, as it is read back from a file or from
 * the wire: a whole valid assignment, or none. A required field that is not
 * valid drops the assignment; an optional one that is not valid is dropped
 * alone. Nothing is coerced, and nothing unknown is kept.
 */
export function sanitizeWork(value: unknown): WorkAssignment | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const unit = text(v.unit, WORK_LIMITS.unit)
  const kind = oneOf(WORK_KINDS, v.kind)
  const label = text(v.label, WORK_LIMITS.label)
  const role = oneOf(WORK_ROLES, v.role)
  const standing = oneOf(WORK_STANDINGS, v.standing)
  const joinedAt = stamp(v.joinedAt)
  const since = stamp(v.since)
  if (
    !unit ||
    !kind ||
    !label ||
    !role ||
    !standing ||
    joinedAt === undefined ||
    since === undefined
  )
    return undefined
  if (!roleFitsKind(role, kind)) return undefined
  const out: WorkAssignment = { unit, kind, label, role, standing, joinedAt, since }
  if (kind === 'lane') {
    const wave = text(v.wave, WORK_LIMITS.unit)
    if (wave) {
      out.wave = wave
      const waveLabel = text(v.waveLabel, WORK_LIMITS.label)
      if (waveLabel) out.waveLabel = waveLabel
    }
  }
  const task = text(v.task, WORK_LIMITS.task)
  if (task) out.task = task
  if (isSessionId(v.from)) out.from = v.from
  return out
}

// ── Changing an assignment ──

/** What an assigner says about a session's work; the unit's own facts (kind,
 *  label, wave) default to what the unit's other members carry. */
export interface WorkAssignInput {
  unit: string
  kind?: WorkKind
  label?: string
  wave?: string
  waveLabel?: string
  role: WorkRole
  task?: string
}

/**
 * The changes an assignment goes through, each applied to one session:
 * - `assign`: join a unit in a role, or update it; an exclusive role someone
 *   else holds is refused unless `replace`, which supersedes that holder;
 * - `complete`: the session's current assignment ended normally;
 * - `leave`: the session belongs to no unit any more;
 * - `offer`: the current holder names its successor, who becomes `pending`;
 * - `cancel`: the holder withdraws its offer;
 * - `accept`: the pending successor takes the role over, and the holder that
 *   offered it is superseded.
 */
export type WorkChange =
  | { type: 'assign'; work: WorkAssignInput; replace?: boolean }
  | { type: 'complete' }
  | { type: 'leave' }
  | { type: 'offer'; to: string }
  | { type: 'cancel' }
  | { type: 'accept'; replace?: boolean }

/** One record to rewrite: its new assignment, or null for none. */
export interface WorkUpdate {
  id: string
  work: WorkAssignment | null
}

/** A change the records refuse, in words an agent or a person can act on. */
export class WorkChangeRefusal extends Error {
  override readonly name = 'WorkChangeRefusal'
}

/** The change names a session no record and no running session knows. A
 *  plain class, so the shell can throw it without loading the wire schema
 *  at boot; the server answers it as its declared not-found. */
export class WorkSessionUnknown extends Error {
  override readonly name = 'WorkSessionUnknown'
}

/** A session as the transitions read it: its id and its assignment, if any. */
export interface WorkRecord {
  id: string
  work?: WorkAssignment | null
}

const refuse = (message: string): never => {
  throw new WorkChangeRefusal(message)
}

const roleName = (role: WorkRole): string => role

/** The unit facts every member carries, from one assignment. */
function unitFacts(
  w: WorkAssignment
): Pick<WorkAssignment, 'unit' | 'kind' | 'label' | 'wave' | 'waveLabel'> {
  return {
    unit: w.unit,
    kind: w.kind,
    label: w.label,
    ...(w.wave !== undefined ? { wave: w.wave } : {}),
    ...(w.waveLabel !== undefined ? { waveLabel: w.waveLabel } : {})
  }
}

function sameFacts(a: WorkAssignment, b: ReturnType<typeof unitFacts>): boolean {
  return (
    a.kind === b.kind && a.label === b.label && a.wave === b.wave && a.waveLabel === b.waveLabel
  )
}

/**
 * Apply one change to the session `id`, against every record that exists
 * (`all`: the sessions' own assignments, so that a role's holder and a
 * handover's ends are known). Answers the records to rewrite, the subject's
 * first; throws `WorkChangeRefusal` when the change cannot be made. Pure: the
 * caller writes the records and tells the windows.
 */
export function applyWorkChange(
  all: ReadonlyArray<WorkRecord>,
  id: string,
  change: WorkChange,
  now: number
): WorkUpdate[] {
  const byId = new Map(all.map((r) => [r.id, r.work ? sanitizeWork(r.work) : undefined]))
  if (!byId.has(id)) throw new WorkSessionUnknown(`No session with id "${id}"`)
  const self = byId.get(id)
  const membersOf = (unit: string): { id: string; work: WorkAssignment }[] =>
    [...byId]
      .filter((entry): entry is [string, WorkAssignment] => entry[1]?.unit === unit)
      .map(([mid, work]) => ({ id: mid, work }))

  switch (change.type) {
    case 'assign':
      return assign(byId, membersOf, id, self, change.work, change.replace === true, now)
    case 'complete': {
      if (!self || self.standing !== 'current')
        refuse('This tab holds no current assignment to complete')
      return [{ id, work: { ...self!, standing: 'completed', since: now } }]
    }
    case 'leave': {
      if (!self) refuse('This tab belongs to no wave or lane')
      return [{ id, work: null }]
    }
    case 'offer':
      return offer(byId, membersOf, id, self, change.to, now)
    case 'cancel': {
      if (!self) refuse('This tab belongs to no wave or lane')
      const pending = membersOf(self!.unit).filter(
        (m) => m.work.standing === 'pending' && m.work.from === id
      )
      if (!pending.length) refuse('No handover from this tab is pending')
      return pending.map((m) => ({ id: m.id, work: null }))
    }
    case 'accept':
      return accept(membersOf, id, self, change.replace === true, now)
  }
}

function assign(
  byId: Map<string, WorkAssignment | undefined>,
  membersOf: (unit: string) => { id: string; work: WorkAssignment }[],
  id: string,
  self: WorkAssignment | undefined,
  input: WorkAssignInput,
  replace: boolean,
  now: number
): WorkUpdate[] {
  const unit =
    text(input.unit, WORK_LIMITS.unit) ?? refuse('A unit key is required (1 to 200 characters)')
  const role = oneOf(WORK_ROLES, input.role) ?? refuse(`A role is one of ${WORK_ROLES.join(', ')}`)
  if (input.label !== undefined && text(input.label, WORK_LIMITS.label) === undefined)
    refuse(`A label is 1 to ${WORK_LIMITS.label} characters`)
  if (input.task !== undefined && text(input.task, WORK_LIMITS.task) === undefined)
    refuse(`A task is 1 to ${WORK_LIMITS.task} characters`)
  if (input.wave !== undefined && text(input.wave, WORK_LIMITS.unit) === undefined)
    refuse('A wave key is 1 to 200 characters')
  if (input.waveLabel !== undefined && text(input.waveLabel, WORK_LIMITS.label) === undefined)
    refuse(`A wave label is 1 to ${WORK_LIMITS.label} characters`)
  if (input.kind !== undefined && !oneOf(WORK_KINDS, input.kind))
    refuse(`A kind is one of ${WORK_KINDS.join(', ')}`)

  const members = membersOf(unit)
  const sameUnit = self?.unit === unit
  // The unit's facts: the session's own when it is already a member, else
  // another member's, else what the assigner says (a new unit needs them).
  const template = (sameUnit ? self : undefined) ?? members.find((m) => m.id !== id)?.work
  if (template && input.kind !== undefined && input.kind !== template.kind)
    refuse(`"${template.label}" is a ${template.kind}; it cannot also be a ${input.kind}`)
  const kind = input.kind ?? template?.kind ?? refuse('A new unit needs its kind: wave or lane')
  const label =
    text(input.label, WORK_LIMITS.label) ??
    template?.label ??
    refuse('A new unit needs its label: a short result, as its sidebar entry shows it')
  if (!roleFitsKind(role, kind))
    refuse(
      kind === 'wave'
        ? 'A wave is held by a coordinator: its roles are coordinator, verifier and worker'
        : 'A lane is held by a lead: its roles are lead, verifier and worker'
    )
  const wave = kind === 'lane' ? (text(input.wave, WORK_LIMITS.unit) ?? template?.wave) : undefined
  const waveLabel =
    kind === 'lane' && wave
      ? (text(input.waveLabel, WORK_LIMITS.label) ??
        (template?.wave === wave ? template?.waveLabel : undefined))
      : undefined
  const facts = unitFacts({
    unit,
    kind,
    label,
    ...(wave !== undefined ? { wave } : {}),
    ...(waveLabel !== undefined ? { waveLabel } : {})
  } as WorkAssignment)

  // A session holds one unit at a time: leaving a role it holds now in
  // another unit would orphan that unit without a word, so it is refused.
  if (self && !sameUnit && self.standing === 'current' && EXCLUSIVE_ROLES.has(self.role))
    refuse(
      `This tab is the current ${roleName(self.role)} of "${self.label}"; hand that over or leave it before joining "${label}"`
    )

  const updates: WorkUpdate[] = []
  let from: string | undefined = sameUnit ? self!.from : undefined
  if (EXCLUSIVE_ROLES.has(role)) {
    const holders = members.filter(
      (m) => m.id !== id && m.work.role === role && m.work.standing === 'current'
    )
    if (holders.length && !replace)
      refuse(
        `"${label}" already has a current ${roleName(role)} (${holders
          .map((h) => h.id)
          .join(', ')}). Hand it over from that tab, or pass replace: true to take the role over`
      )
    for (const h of holders)
      updates.push({ id: h.id, work: { ...h.work, standing: 'superseded', since: now } })
    if (holders.length === 1) from = holders[0].id
  }
  const keepsStanding = sameUnit && self!.role === role && self!.standing === 'current'
  const task =
    text(input.task, WORK_LIMITS.task) ?? (sameUnit && self!.role === role ? self!.task : undefined)
  const next: WorkAssignment = {
    ...facts,
    role,
    ...(task !== undefined ? { task } : {}),
    standing: 'current',
    joinedAt: sameUnit ? self!.joinedAt : now,
    since: keepsStanding ? self!.since : now,
    ...(from !== undefined ? { from } : {})
  }
  updates.unshift({ id, work: next })
  // The unit's facts are the unit's: a new label reaches every member.
  for (const m of members) {
    if (m.id === id || updates.some((u) => u.id === m.id)) continue
    if (!sameFacts(m.work, facts)) updates.push({ id: m.id, work: { ...m.work, ...facts } })
  }
  // A unit's facts that a replaced holder carries follow too.
  for (const u of updates) {
    if (u.id !== id && u.work && !sameFacts(u.work, facts)) u.work = { ...u.work, ...facts }
  }
  void byId
  return updates
}

function offer(
  byId: Map<string, WorkAssignment | undefined>,
  membersOf: (unit: string) => { id: string; work: WorkAssignment }[],
  id: string,
  self: WorkAssignment | undefined,
  to: string,
  now: number
): WorkUpdate[] {
  if (!self || self.standing !== 'current')
    refuse('Only the tab that holds a role now can hand it over')
  if (!isSessionId(to)) refuse('A successor is named by its session id')
  if (to === id) refuse('A tab cannot hand its role over to itself')
  if (!byId.has(to)) refuse(`No session with id "${to}"`)
  const target = byId.get(to)
  const holder = self!
  if (
    target &&
    target.unit !== holder.unit &&
    target.standing === 'current' &&
    EXCLUSIVE_ROLES.has(target.role)
  )
    refuse(
      `That tab is the current ${roleName(target.role)} of "${target.label}"; it cannot take "${holder.label}" over too`
    )
  const updates: WorkUpdate[] = []
  // An earlier offer for the same role is withdrawn: one successor at a time.
  for (const m of membersOf(holder.unit)) {
    if (m.id === to) continue
    if (m.work.standing === 'pending' && m.work.from === id && m.work.role === holder.role)
      updates.push({ id: m.id, work: null })
  }
  const next: WorkAssignment = {
    ...unitFacts(holder),
    role: holder.role,
    ...(holder.task !== undefined ? { task: holder.task } : {}),
    standing: 'pending',
    joinedAt: target?.unit === holder.unit ? target.joinedAt : now,
    since: now,
    from: id
  }
  updates.unshift({ id: to, work: next })
  return updates
}

function accept(
  membersOf: (unit: string) => { id: string; work: WorkAssignment }[],
  id: string,
  self: WorkAssignment | undefined,
  replace: boolean,
  now: number
): WorkUpdate[] {
  if (!self || self.standing !== 'pending') refuse('This tab has no pending handover to accept')
  const successor = self!
  const members = membersOf(successor.unit)
  const holders = members.filter(
    (m) => m.id !== id && m.work.role === successor.role && m.work.standing === 'current'
  )
  const others = holders.filter((h) => h.id !== successor.from)
  if (EXCLUSIVE_ROLES.has(successor.role) && others.length && !replace)
    refuse(
      `The ${roleName(successor.role)} of "${successor.label}" is now held by ${others
        .map((h) => h.id)
        .join(
          ', '
        )}, not by the tab that offered the handover; pass replace: true to take it anyway`
    )
  const updates: WorkUpdate[] = [{ id, work: { ...successor, standing: 'current', since: now } }]
  for (const h of holders) {
    // The holder that offered steps back; others only when told to replace.
    if (h.id === successor.from || (replace && EXCLUSIVE_ROLES.has(successor.role)))
      updates.push({ id: h.id, work: { ...h.work, standing: 'superseded', since: now } })
  }
  return updates
}

// ── Reading the entries ──

/** Who holds a role in a unit, as the records say it. */
export type WorkHolding =
  /** One session holds it now. */
  | { state: 'held'; id: string }
  /** Nobody holds it and nothing says somebody should (a lane with no verifier). */
  | { state: 'vacant' }
  /** The last holder completed it. */
  | { state: 'completed'; id: string }
  /** The records disagree or leave it without a holder: shown as such, with
   *  the sessions a person can choose between. */
  | {
      state: 'unresolved'
      reason: 'several' | 'not-accepted' | 'no-current'
      candidates: string[]
    }

export interface WorkPending {
  id: string
  role: WorkRole
  /** The holder that offered the role, when the record names one. */
  from?: string
}

export interface WorkHistoryItem {
  id: string
  role: WorkRole
  standing: 'superseded' | 'completed'
  since: number
  /** The session that took the role over from this one, when it is open. */
  successor?: string
}

/** One unit as its entry shows it. */
export interface WorkUnitView {
  unit: string
  kind: WorkKind
  label: string
  wave?: { unit: string; label: string }
  ownerRole: OwnerRole
  owner: WorkHolding
  reviewer: WorkHolding
  /** Current workers, earliest-joined first. */
  workers: string[]
  /** Successors waiting to take a role over. */
  pending: WorkPending[]
  /** Members who no longer hold their role, the latest change first. */
  history: WorkHistoryItem[]
  /** Every member, earliest-joined first. */
  members: string[]
}

const byJoin = (
  a: { id: string; work: WorkAssignment },
  b: { id: string; work: WorkAssignment }
): number => a.work.joinedAt - b.work.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

function holdingOf(
  members: { id: string; work: WorkAssignment }[],
  role: WorkRole,
  owner: boolean
): WorkHolding {
  const withRole = members.filter((m) => m.work.role === role)
  const current = withRole.filter((m) => m.work.standing === 'current')
  if (current.length === 1) return { state: 'held', id: current[0].id }
  if (current.length > 1)
    return { state: 'unresolved', reason: 'several', candidates: current.map((m) => m.id) }
  const pending = withRole.filter((m) => m.work.standing === 'pending')
  if (pending.length)
    return { state: 'unresolved', reason: 'not-accepted', candidates: pending.map((m) => m.id) }
  const completed = withRole
    .filter((m) => m.work.standing === 'completed')
    .sort((a, b) => b.work.since - a.work.since)
  if (completed.length) return { state: 'completed', id: completed[0].id }
  const superseded = withRole.filter((m) => m.work.standing === 'superseded')
  // A lane whose current lead left it with only superseded leads behind has
  // no owner, which a person must settle; a superseded verifier leaves the
  // role vacant, a normal state between rounds.
  if (owner && superseded.length)
    return {
      state: 'unresolved',
      reason: 'no-current',
      candidates: superseded.map((m) => m.id)
    }
  return { state: 'vacant' }
}

/**
 * The units the sessions belong to, each as its entry shows it. The input is
 * the open sessions with their assignments, in any order; a session without
 * a valid assignment is left out. Nothing here reads a title, a timestamp of
 * activity or a provider: who holds a role comes from the standings alone,
 * and the join time only orders the members.
 */
export function deriveWorkUnits(sessions: ReadonlyArray<WorkRecord>): WorkUnitView[] {
  const groups = new Map<string, { id: string; work: WorkAssignment }[]>()
  for (const s of sessions) {
    const work = s.work ? sanitizeWork(s.work) : undefined
    if (!work) continue
    const list = groups.get(work.unit) ?? []
    list.push({ id: s.id, work })
    groups.set(work.unit, list)
  }
  const views: WorkUnitView[] = []
  for (const [unit, unsorted] of groups) {
    const members = [...unsorted].sort(byJoin)
    const first = members[0].work
    const ownerRole = ownerRoleOf(first.kind)
    // Members of one unit agree on its facts; if records disagree, the
    // earliest-joined member's facts are shown, never the newest.
    const facts = members.find((m) => m.work.kind === first.kind)!.work
    const sameKind = members.filter((m) => m.work.kind === first.kind)
    const owner = holdingOf(sameKind, ownerRole, true)
    const reviewer = holdingOf(sameKind, 'verifier', false)
    const label =
      owner.state === 'held'
        ? (sameKind.find((m) => m.id === owner.id)?.work.label ?? facts.label)
        : facts.label
    const waveOf = members.find((m) => m.work.wave)?.work
    const successorOf = (id: string, role: WorkRole): string | undefined =>
      members.find(
        (m) =>
          m.work.from === id &&
          m.work.role === role &&
          (m.work.standing === 'current' ||
            m.work.standing === 'superseded' ||
            m.work.standing === 'completed')
      )?.id
    views.push({
      unit,
      kind: first.kind,
      label,
      ...(waveOf?.wave
        ? { wave: { unit: waveOf.wave, label: waveOf.waveLabel ?? waveOf.wave } }
        : {}),
      ownerRole,
      owner,
      reviewer,
      workers: sameKind
        .filter((m) => m.work.role === 'worker' && m.work.standing === 'current')
        .map((m) => m.id),
      pending: sameKind
        .filter((m) => m.work.standing === 'pending')
        .map((m) => ({
          id: m.id,
          role: m.work.role,
          ...(m.work.from !== undefined ? { from: m.work.from } : {})
        })),
      history: members
        .filter((m) => m.work.standing === 'superseded' || m.work.standing === 'completed')
        .sort((a, b) => b.work.since - a.work.since || byJoin(a, b))
        .map((m) => {
          const successor = successorOf(m.id, m.work.role)
          return {
            id: m.id,
            role: m.work.role,
            standing: m.work.standing as 'superseded' | 'completed',
            since: m.work.since,
            ...(successor !== undefined ? { successor } : {})
          }
        }),
      members: members.map((m) => m.id)
    })
  }
  return views
}
