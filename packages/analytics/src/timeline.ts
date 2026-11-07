import type { Block, ViewRow } from './ledger'

/**
 * The pure half of the drawings: one time scale for the session's timeline and the group's
 * swimlane (the wall clock from the first block to the last, nice ticks in local time), the
 * lanes a swimlane draws (one per session row, in the table's order), the waits between
 * blocks, and the words a hover shows. No DOM here; the page script draws from these.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The tick steps a scale may take, smallest first. */
export const STEPS_MS: readonly number[] = [
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY
]

export interface Span {
  start: number
  end: number
}

/** The wall clock of a block list: the first start to the last end, in ms; null when empty. */
export function spanOf(list: readonly Block[]): Span | null {
  let start = Infinity
  let end = -Infinity
  for (const b of list) {
    const s = Date.parse(b.start)
    const e = Date.parse(b.end)
    if (Number.isNaN(s) || Number.isNaN(e)) continue
    if (s < start) start = s
    if (e > end) end = e
  }
  return start <= end ? { start, end } : null
}

/** The wall clock of several lanes at once. */
export function spanOfAll(lanes: readonly (readonly Block[])[]): Span | null {
  const spans = lanes.map(spanOf).filter((s): s is Span => s !== null)
  if (spans.length === 0) return null
  return {
    start: Math.min(...spans.map((s) => s.start)),
    end: Math.max(...spans.map((s) => s.end))
  }
}

/** The smallest step whose ticks sit at least `minPx` apart over `width` pixels. */
export function tickStep(spanMs: number, width: number, minPx = 72): number {
  const most = Math.max(1, Math.floor(width / minPx))
  for (const step of STEPS_MS) if (spanMs / step <= most) return step
  return STEPS_MS[STEPS_MS.length - 1]!
}

export interface Tick {
  t: number
  /** `09:00` under a step shorter than a day; `4 Nov` on a midnight and from a day up. */
  label: string
  /** A tick on a local midnight: it names its day, so a clock over several days reads. */
  day: boolean
}

export interface TimeScale extends Span {
  width: number
  step: number
  ticks: Tick[]
  x(t: number): number
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** `09:05`, local time. */
export function formatClock(t: number | string): string {
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `4 Nov`, local time. */
export function formatDay(t: number | string): string {
  const d = new Date(t)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

function localMidnight(t: number): number {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * A scale over a span: ticks on local-time boundaries (multiples of the step counted from
 * the local midnight before the span, whole local days from a day up), and `x` mapping a
 * moment onto `width` pixels. A span shorter than a minute is widened to one so a single
 * message still has a clock under it.
 */
export function timeScale(span: Span, width: number, minTickPx = 72): TimeScale {
  const { start } = span
  const end = span.end - start < MINUTE ? start + MINUTE : span.end
  const step = tickStep(end - start, width, minTickPx)
  const ticks: Tick[] = []
  if (step >= DAY) {
    const days = Math.round(step / DAY)
    let t = localMidnight(start)
    if (t < start) t = localMidnight(t + DAY + HOUR)
    while (t <= end) {
      ticks.push({ t, label: formatDay(t), day: true })
      const next = new Date(t)
      next.setDate(next.getDate() + days)
      t = next.getTime()
    }
  } else {
    const first = localMidnight(start)
    let t = first + Math.ceil((start - first) / step) * step
    while (t <= end) {
      const day = t === localMidnight(t)
      ticks.push({ t, label: day ? formatDay(t) : formatClock(t), day })
      t += step
    }
  }
  const scale = end > start ? width / (end - start) : 0
  return {
    start,
    end,
    width,
    step,
    ticks,
    x: (t: number): number => Math.min(width, Math.max(0, (t - start) * scale))
  }
}

/** A block's place on a scale: at least `minWidth` pixels wide so a short block is seen. */
export function blockRect(scale: TimeScale, block: Block, minWidth = 3): { x: number; w: number } {
  const x0 = scale.x(Date.parse(block.start))
  const x1 = scale.x(Date.parse(block.end))
  const w = Math.max(minWidth, x1 - x0)
  return { x: Math.min(x0, scale.width - w), w }
}

export interface Wait {
  from: string
  to: string
  minutes: number
}

/** The silences between consecutive blocks, in order; none for fewer than two blocks. */
export function waits(list: readonly Block[]): Wait[] {
  const out: Wait[] = []
  for (let i = 1; i < list.length; i++) {
    const from = list[i - 1]!.end
    const to = list[i]!.start
    const minutes = (Date.parse(to) - Date.parse(from)) / MINUTE
    if (Number.isFinite(minutes) && minutes > 0) out.push({ from, to, minutes })
  }
  return out
}

export interface Lane {
  id: string
  label: string
  state: string | null
  blocks: Block[]
}

/** The swimlane's lanes: one per session row, in the table's order, with its state dot. */
export function laneRows(rows: readonly ViewRow[]): Lane[] {
  return rows
    .filter((r) => r.kind === 'session')
    .map((r) => ({ id: r.id, label: r.name, state: r.state, blocks: r.blocks }))
}

/** `46 min`, `1 h 05`, `2 d 03 h`: a duration a hover says. */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) return `${total} min`
  const hours = Math.floor(total / 60)
  if (hours < 48) return `${hours} h ${pad(total % 60)}`
  const days = Math.floor(hours / 24)
  return `${days} d ${pad(hours % 24)} h`
}

/** The lines a hover shows for a block: when, how long, what it held, its pace. */
export function blockWords(block: Block): string[] {
  const perMinute = block.minutes > 0 ? block.toolCalls / block.minutes : block.toolCalls
  const pace =
    block.toolCalls === 0
      ? 'no tool call'
      : `${block.toolCalls} tool ${block.toolCalls === 1 ? 'call' : 'calls'}, ${
          block.minutes > 0 ? perMinute.toFixed(1) : String(block.toolCalls)
        } a minute`
  return [
    `${formatClock(block.start)} to ${formatClock(block.end)} · ${formatDuration(block.minutes)}`,
    `${block.messages} ${block.messages === 1 ? 'message' : 'messages'}, ${pace}`
  ]
}

/** The line a hover shows for a wait between two blocks. */
export function waitWords(wait: Wait): string[] {
  return [
    `Waited ${formatDuration(wait.minutes)}`,
    `${formatClock(wait.from)} to ${formatClock(wait.to)}`
  ]
}
