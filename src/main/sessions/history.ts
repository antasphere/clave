import type { HistoryItem, HistoryPage } from '../../shared/session-model'
import type { TimelineFile } from './timeline-store'

/** How much of a conversation's past a view gets per ask, in events: about a
 *  screen and a half of turns once tool runs have folded into their rows. */
export const HISTORY_PAGE = 200
/** The most one ask may take, whatever it names. */
export const HISTORY_PAGE_MAX = 2000

/** Where a page of a conversation's past may begin, and which of those places
 *  begin a turn. A view reduces each page on its own and puts it in front of
 *  the next, so a page may never split what the reducer pairs across events:
 *  a tool call and its result, an interrupt and the message it mutes, or the
 *  deltas of one streamed message.
 *  `windowed`: `items` is a window of a longer conversation that begins after
 *  its first event, so a result whose call is not in it had its call before
 *  the window, and nothing up to that result is a place to cut. */
function boundaries(items: HistoryItem[], windowed = false): { turn: boolean[]; step: boolean[] } {
  const last = new Map<string, number>()
  const calls = new Set<string>()
  // `reach`: the furthest a call opened before this event still runs to.
  let reach = -1
  items.forEach(({ event }, i) => {
    if (event.type === 'tool_call' || event.type === 'tool_result') last.set(event.id, i)
    if (event.type === 'tool_call') calls.add(event.id)
    if (windowed && event.type === 'tool_result' && !calls.has(event.id)) reach = i
  })
  const turn: boolean[] = []
  const step: boolean[] = []
  items.forEach(({ event }, i) => {
    const toolSafe = reach < i
    turn[i] = toolSafe && event.type === 'user_message'
    // A streamed message is one event per delta: a page that began between
    // two of them would show the message cut in two (PRDCT-4666).
    const previous = items[i - 1]?.event
    const streaming = previous?.type === 'assistant_text' && previous.final !== true
    step[i] =
      toolSafe && ((event.type === 'assistant_text' && !streaming) || event.type === 'tool_call')
    if (event.type === 'tool_call' || event.type === 'tool_result')
      reach = Math.max(reach, last.get(event.id) ?? i)
  })
  // A step inside a turn that ends interrupted is no place to cut: the mark
  // lands on the turn's message, which would be on the page before.
  let interrupted = false
  for (let i = items.length - 1; i >= 0; i--) {
    const type = items[i].event.type
    if (type === 'turn_interrupted') interrupted = true
    if (interrupted) step[i] = false
    if (type === 'user_message') interrupted = false
  }
  return { turn, step }
}

/** The page of `items` that ends where `before` does (the end, when absent),
 *  about `limit` events long. It begins at a turn when one begins within a
 *  further page's length, else at a step of the turn, else at the start: one
 *  very long turn is paged by its steps rather than handed over whole. */
export function pageHistory(
  items: HistoryItem[],
  before?: number,
  limit = HISTORY_PAGE
): HistoryPage {
  const end = Math.max(0, Math.min(before ?? items.length, items.length))
  const size = pageSize(limit)
  const target = end - size
  if (target <= 0) return { items: items.slice(0, end), before: null }
  const start = pickStart(boundaries(items), 0, target, size) ?? 0
  return { items: items.slice(start, end), before: start > 0 ? start : null }
}

const pageSize = (limit: number): number =>
  Math.max(1, Math.min(Math.floor(limit) || HISTORY_PAGE, HISTORY_PAGE_MAX))

/** `pageHistory`'s rule for where a page ending past `target` begins, over
 *  boundaries computed from index `offset`: a turn within `size` further
 *  back, else the nearest step at or before the target. Indices are absolute;
 *  only those above `floor` are candidates. Undefined when none is. */
function pickStart(
  { turn, step }: { turn: boolean[]; step: boolean[] },
  offset: number,
  target: number,
  size: number,
  floor = 0
): number | undefined {
  for (let i = target; i > floor && i >= target - size; i--) if (turn[i - offset]) return i
  for (let i = target; i > floor; i--) if (step[i - offset]) return i
  return undefined
}

/** The page of a conversation kept on disk that ends at index `end`, chosen
 *  by `pageHistory`'s rules without reading the whole file: a window around
 *  the end is read, and widened until a place to begin is in it. On a
 *  conversation that fits in one window it answers what `pageHistory` does. */
export function pageWindow(
  file: Pick<TimelineFile, 'length' | 'slice'>,
  end: number,
  limit = HISTORY_PAGE
): { items: HistoryItem[]; start: number } {
  const last = Math.max(0, Math.min(end, file.length))
  const size = pageSize(limit)
  const target = last - size
  if (target <= 0) return { items: file.slice(0, last), start: 0 }
  for (let span = Math.max(4 * size, 800); ; span *= 2) {
    const from = Math.max(0, last - span)
    const window = file.slice(from, Math.min(file.length, last + span))
    // The window's first event has its past outside: never a place to begin.
    const start = pickStart(boundaries(window, from > 0), from, target, size, from)
    if (start !== undefined) return { items: window.slice(start - from, last - from), start }
    if (from === 0) return { items: window.slice(0, last), start: 0 }
  }
}
