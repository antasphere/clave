/**
 * A five-field cron expression (ADR 0004): minute, hour, day of month,
 * month, day of week, evaluated in the machine's local time. `*`, lists,
 * ranges, steps (every fifteen minutes is star slash 15, `1-5/2`), month and weekday names; no seconds
 * field, no `@daily` aliases, no `L`, `W` or `#`. Day of month and day of
 * week combine as cron does: when both are restricted, either one matching
 * is enough.
 *
 * Pure and leaf: the next occurrence is found by stepping minutes in local
 * time through `Date`'s own local getters, so a clock change is the
 * machine's: a 02:30 on the spring-forward day never comes, the 02:30 of
 * the fall-back day comes once (the scheduler considers each occurrence
 * once, by its timestamp).
 */

export interface CronField {
  readonly values: ReadonlySet<number>
  /** Whether the field was `*` (unrestricted), which matters for the day rule. */
  readonly any: boolean
}

export interface CronSchedule {
  readonly minute: CronField
  readonly hour: CronField
  readonly dayOfMonth: CronField
  readonly month: CronField
  readonly dayOfWeek: CronField
  readonly source: string
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const FULL_MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
]
const FULL_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export class CronParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CronParseError'
  }
}

/** A name is its three-letter form or its full form, nothing in between and
 *  nothing beyond (`fri`, `friday`; never `fried`, round 1 F7). */
function nameToNumber(token: string, names: string[], field: string): number | null {
  const lower = token.toLowerCase()
  const full = field === 'month' ? FULL_MONTHS : FULL_DAYS
  const at = lower.length === 3 ? names.indexOf(lower) : full.indexOf(lower)
  if (at < 0) return null
  // Months are 1-based in cron, weekdays 0-based.
  return field === 'month' ? at + 1 : at
}

/** A whole number written in digits, nothing else (`05` is 5; `0x5`, `1e1`, `-5` are not values). */
const DIGITS = /^\d+$/

function parseField(
  text: string,
  min: number,
  max: number,
  field: string,
  names?: string[]
): CronField {
  const values = new Set<number>()
  if (text === '*') {
    for (let v = min; v <= max; v++) values.add(v)
    return { values, any: true }
  }
  for (const part of text.split(',')) {
    if (part === '') throw new CronParseError(`${field}: an empty list item in "${text}"`)
    const [rangeText, stepText, ...more] = part.split('/')
    if (more.length > 0 || rangeText === '')
      throw new CronParseError(`${field}: "${part}" is not a value, a range or a step`)
    const step = stepText === undefined ? 1 : DIGITS.test(stepText) ? Number(stepText) : NaN
    if (stepText !== undefined && (!Number.isInteger(step) || step <= 0))
      throw new CronParseError(
        `${field}: a step must be a positive whole number, got "${stepText}"`
      )
    let lo: number
    let hi: number
    if (rangeText === '*') {
      lo = min
      hi = max
    } else {
      const [a, b, ...beyond] = rangeText.split('-')
      if (beyond.length > 0)
        throw new CronParseError(`${field}: "${part}" is not a value, a range or a step`)
      const parse = (t: string): number => {
        if (DIGITS.test(t)) return Number(t)
        const named = names ? nameToNumber(t, names, field) : null
        if (named === null) throw new CronParseError(`${field}: "${t}" is not a value`)
        return named
      }
      lo = parse(a)
      hi = b === undefined ? (stepText !== undefined ? max : lo) : parse(b)
    }
    // Sunday may be written 7: a value of 7 in the weekday field reads as 0,
    // so `5-7` is Friday, Saturday, Sunday.
    const top = field === 'day of week' ? 7 : max
    if (lo < min || hi > top || lo > hi)
      throw new CronParseError(`${field}: "${part}" is outside ${min}-${max}`)
    for (let v = lo; v <= hi; v += step) values.add(field === 'day of week' && v === 7 ? 0 : v)
  }
  return { values, any: false }
}

/** Parse an expression; throws `CronParseError` with the field and the token at fault. */
export function parseCron(source: string): CronSchedule {
  const fields = source.trim().split(/\s+/)
  if (fields.length !== 5)
    throw new CronParseError(
      `a schedule has five fields (minute hour day-of-month month day-of-week), got ${fields.length}`
    )
  const [m, h, dom, mon, dow] = fields
  return {
    minute: parseField(m, 0, 59, 'minute'),
    hour: parseField(h, 0, 23, 'hour'),
    dayOfMonth: parseField(dom, 1, 31, 'day of month'),
    month: parseField(mon, 1, 12, 'month', MONTHS),
    dayOfWeek: parseField(dow, 0, 6, 'day of week', DAYS),
    source: source.trim()
  }
}

/** Whether the schedule matches the local minute `at` falls in. */
export function matchesAt(schedule: CronSchedule, at: Date): boolean {
  if (!schedule.minute.values.has(at.getMinutes())) return false
  if (!schedule.hour.values.has(at.getHours())) return false
  if (!schedule.month.values.has(at.getMonth() + 1)) return false
  const domOk = schedule.dayOfMonth.values.has(at.getDate())
  const dowOk = schedule.dayOfWeek.values.has(at.getDay())
  // Cron's day rule: both restricted → either; one restricted → that one.
  if (!schedule.dayOfMonth.any && !schedule.dayOfWeek.any) return domOk || dowOk
  if (!schedule.dayOfMonth.any) return domOk
  if (!schedule.dayOfWeek.any) return dowOk
  return true
}

/** The start of the local minute after `after`. */
function nextMinute(after: number): Date {
  const d = new Date(after)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  return d
}

/** The first occurrence strictly after `after` (epoch ms), or null when none
 *  comes within `horizonDays` (a schedule like `0 0 31 2 *`). Steps minute
 *  by minute at most through a day, then jumps to the next day, so a sparse
 *  schedule costs at most a few thousand steps. */
export function nextOccurrence(
  schedule: CronSchedule,
  after: number,
  horizonDays = 366 * 4
): number | null {
  let at = nextMinute(after)
  const horizon = after + horizonDays * 86_400_000
  while (at.getTime() <= horizon) {
    if (!schedule.month.values.has(at.getMonth() + 1)) {
      // Jump to the first day of the next month, at 00:00.
      at = new Date(at.getFullYear(), at.getMonth() + 1, 1, 0, 0, 0, 0)
      continue
    }
    const dayOk = matchesDay(schedule, at)
    if (!dayOk) {
      at = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, 0, 0, 0, 0)
      continue
    }
    if (!schedule.hour.values.has(at.getHours())) {
      at = new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours() + 1, 0, 0, 0)
      continue
    }
    if (schedule.minute.values.has(at.getMinutes())) return at.getTime()
    at = nextMinute(at.getTime())
  }
  return null
}

function matchesDay(schedule: CronSchedule, at: Date): boolean {
  const domOk = schedule.dayOfMonth.values.has(at.getDate())
  const dowOk = schedule.dayOfWeek.values.has(at.getDay())
  if (!schedule.dayOfMonth.any && !schedule.dayOfWeek.any) return domOk || dowOk
  if (!schedule.dayOfMonth.any) return domOk
  if (!schedule.dayOfWeek.any) return dowOk
  return true
}

/** The last occurrence at or before `at`, or null when none within four
 *  years: the latest of a deep catch-up is named by this, never by the
 *  thousandth miss (round 1, F8). Windows of growing size are searched back. */
export function lastOccurrence(schedule: CronSchedule, at: number): number | null {
  for (const days of [2, 60, 400, 366 * 4]) {
    const from = at - days * 86_400_000
    let cursor = from
    let last: number | null = null
    // Walk the window forward; a sparse schedule has few occurrences in it.
    for (;;) {
      const next = nextOccurrence(schedule, cursor, days + 1)
      if (next === null || next > at) break
      last = next
      cursor = next
    }
    if (last !== null) return last
  }
  return null
}

/** Every occurrence in `(from, to]`, oldest first, at most `limit` of them
 *  (the scheduler collapses them into one run anyway). */
export function occurrencesBetween(
  schedule: CronSchedule,
  from: number,
  to: number,
  limit = 1000
): number[] {
  const out: number[] = []
  let cursor = from
  while (out.length < limit) {
    const next = nextOccurrence(schedule, cursor, 366)
    if (next === null || next > to) break
    out.push(next)
    cursor = next
  }
  return out
}

/** The schedule in words, for the panel: the common shapes named, the rest
 *  quoted as written. */
export function describeCron(source: string): string {
  let s: CronSchedule
  try {
    s = parseCron(source)
  } catch {
    return `"${source}"`
  }
  const time =
    s.minute.values.size === 1 && s.hour.values.size === 1
      ? `at ${String([...s.hour.values][0]).padStart(2, '0')}:${String([...s.minute.values][0]).padStart(2, '0')}`
      : s.hour.any && s.minute.values.size === 1
        ? `every hour at minute ${[...s.minute.values][0]}`
        : s.hour.any && s.minute.any
          ? 'every minute'
          : s.hour.any && stepOf(s.minute.values, 60)
            ? `every ${stepOf(s.minute.values, 60)} minutes`
            : s.minute.values.size === 1 &&
                [...s.minute.values][0] === 0 &&
                stepOf(s.hour.values, 24)
              ? `every ${stepOf(s.hour.values, 24)} hours`
              : null
  if (!time) return `"${source}"`
  if (!s.month.any) return `"${source}"`
  const dow = [...s.dayOfWeek.values].sort((a, b) => a - b).join(',')
  const days = s.dayOfWeek.any
    ? s.dayOfMonth.any
      ? 'every day'
      : s.dayOfMonth.values.size === 1
        ? `on the ${ordinal([...s.dayOfMonth.values][0])} of every month`
        : null
    : dow === '1,2,3,4,5'
      ? 'weekdays'
      : dow === '0,6'
        ? 'weekends'
        : s.dayOfWeek.values.size === 1
          ? `every ${capitalize(DAYS[[...s.dayOfWeek.values][0]])}`
          : null
  if (!days || (!s.dayOfMonth.any && !s.dayOfWeek.any)) return `"${source}"`
  // "every day every minute" says every day twice.
  return days === 'every day' && time.startsWith('every') ? time : `${days} ${time}`
}

/** The step a field's values are the multiples of (`*\/N`: 0, N, 2N, … up to
 *  the field's span), or null when they are not one. */
const stepOf = (values: ReadonlySet<number>, span: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length < 2 || sorted[0] !== 0) return null
  const step = sorted[1]
  // A step that does not divide the span is not "every N": */45 fires at
  // :00 and :45, forty-five minutes then fifteen.
  if (step < 2 || span % step !== 0 || sorted.length !== span / step) return null
  return sorted.every((v, i) => v === i * step) ? step : null
}

const capitalize = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1)
const ordinal = (n: number): string => {
  const rest = n % 100
  if (rest >= 11 && rest <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}
