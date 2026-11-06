/**
 * The scheduler's rules (ADR 0004), pure over a clock the caller passes:
 * what one tick decides for one routine, given its schedule, what it last
 * considered, whether a run is in flight and whether the routine may run at
 * all. The service (`service.ts`) runs the tick every thirty seconds and
 * whenever the routines change, acts on the decision (claims the
 * occurrence, starts the run, records a skip) and stores `lastConsideredAt`.
 *
 * The rules, each with its test in `scheduler.test.ts`:
 *  - the occurrences in `(lastConsideredAt, now]` are what is due; one or
 *    more make ONE run, the latest occurrence naming it;
 *  - the run is `scheduled` when that occurrence is under `ON_TIME_MS` old,
 *    `catch-up` otherwise; a routine with `catchUp` off skips a late one;
 *  - a routine never seen, or whose schedule changed, starts its clock at
 *    now and catches up nothing from before;
 *  - a run in flight skips the occurrence; a routine that cannot run
 *    (`invalid`) fails it on the record instead of running.
 * A sleep needs no power event: the gap in the ticks is the gap in the
 * occurrences, and the same rule applies when the machine wakes.
 */
import { type CronSchedule, lastOccurrence, occurrencesBetween, parseCron } from './cron'

/** An occurrence under this old at the tick is on time; older is a catch-up. */
export const ON_TIME_MS = 90_000
/** How often the service ticks. */
export const TICK_MS = 30_000

export interface RoutineClock {
  /** When the scheduler last considered this routine, null when never seen. */
  readonly lastConsideredAt: number | null
  /** The schedule last seen for it, to notice a change. */
  readonly schedule: string | null
}

export type TickDecision =
  /** Nothing due; the clock moves to now. */
  | { kind: 'idle' }
  /** The routine was never seen or its schedule changed: its clock starts now. */
  | { kind: 'reset' }
  /** Start a run for the latest due occurrence. */
  | {
      kind: 'run'
      occurrence: number
      trigger: 'scheduled' | 'catch-up'
      /** The occurrences this run stands for (the misses collapsed into it). */
      collapsed: number[]
    }
  /** Due, but not run: the reason is recorded, the clock moves to now. */
  | { kind: 'skip'; occurrence: number; reason: 'running' | 'catch-up-off' }
  /** Due, and the routine cannot run as declared: a failed run on the record. */
  | { kind: 'fail'; occurrence: number; reason: string }

export interface TickInput {
  readonly schedule: string
  readonly catchUp: boolean
  readonly invalid: string | null
  readonly clock: RoutineClock
  readonly running: boolean
  readonly now: number
}

/** Parse once per tick per routine; a schedule that does not parse is the
 *  routine's `invalid` reason (set when the declaration was resolved), so
 *  this throws only on a bug. */
const parsed = new Map<string, CronSchedule>()
function scheduleOf(source: string): CronSchedule {
  let s = parsed.get(source)
  if (!s) {
    s = parseCron(source)
    if (parsed.size > 500) parsed.clear()
    parsed.set(source, s)
  }
  return s
}

export function decideTick(input: TickInput): TickDecision {
  const { clock, now } = input
  if (clock.lastConsideredAt === null || clock.schedule !== input.schedule) return { kind: 'reset' }
  if (input.invalid === null) {
    // A schedule the resolver accepted parses; guard the cache all the same.
    try {
      scheduleOf(input.schedule)
    } catch (error) {
      return { kind: 'fail', occurrence: now, reason: String(error) }
    }
  }
  if (input.invalid !== null) {
    // The occurrences still exist on the clock: each one due is one failure on
    // the record, collapsed like a run would be, so the badge says why.
    let due: number[]
    try {
      due = occurrencesBetween(scheduleOf(input.schedule), clock.lastConsideredAt, now)
    } catch {
      due = []
    }
    if (due.length === 0) return { kind: 'idle' }
    return { kind: 'fail', occurrence: due[due.length - 1], reason: input.invalid }
  }
  const due = occurrencesBetween(scheduleOf(input.schedule), clock.lastConsideredAt, now)
  if (due.length === 0) return { kind: 'idle' }
  // A catch-up deeper than the list's bound is still named by the LATEST
  // occurrence, found directly (round 1, F8).
  const occurrence =
    due.length >= 1000
      ? (lastOccurrence(scheduleOf(input.schedule), now) ?? due[due.length - 1])
      : due[due.length - 1]
  if (input.running) return { kind: 'skip', occurrence, reason: 'running' }
  const trigger: 'scheduled' | 'catch-up' = now - occurrence < ON_TIME_MS ? 'scheduled' : 'catch-up'
  if (trigger === 'catch-up' && !input.catchUp)
    return { kind: 'skip', occurrence, reason: 'catch-up-off' }
  return { kind: 'run', occurrence, trigger, collapsed: due }
}

/** The next occurrence after `now`, for the panel; null for a routine that cannot run. */
export function nextRunAt(schedule: string, invalid: string | null, now: number): number | null {
  if (invalid !== null) return null
  try {
    const next = occurrencesBetween(scheduleOf(schedule), now, now + 366 * 4 * 86_400_000, 1)
    return next[0] ?? null
  } catch {
    return null
  }
}
