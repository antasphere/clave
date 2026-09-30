import type { HistoryItem, HistoryPage } from '../../shared/session-model'

/** How much of a conversation's past a view gets per ask, in events: about a
 *  screen and a half of turns once tool runs have folded into their rows. */
export const HISTORY_PAGE = 200
/** The most one ask may take, whatever it names. */
export const HISTORY_PAGE_MAX = 2000

/** Where a page of a conversation's past may begin, and which of those places
 *  begin a turn. A view reduces each page on its own and puts it in front of
 *  the next, so a page may never split what the reducer pairs across events:
 *  a tool call and its result, or an interrupt and the message it mutes. */
function boundaries(items: HistoryItem[]): { turn: boolean[]; step: boolean[] } {
  const last = new Map<string, number>()
  items.forEach(({ event }, i) => {
    if (event.type === 'tool_call' || event.type === 'tool_result') last.set(event.id, i)
  })
  const turn: boolean[] = []
  const step: boolean[] = []
  // `reach`: the furthest a call opened before this event still runs to.
  let reach = -1
  items.forEach(({ event }, i) => {
    const toolSafe = reach < i
    turn[i] = toolSafe && event.type === 'user_message'
    step[i] = toolSafe && (event.type === 'assistant_text' || event.type === 'tool_call')
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
  const size = Math.max(1, Math.min(Math.floor(limit) || HISTORY_PAGE, HISTORY_PAGE_MAX))
  const target = end - size
  if (target <= 0) return { items: items.slice(0, end), before: null }
  const { turn, step } = boundaries(items)
  let start = 0
  for (let i = target; i > 0 && i >= target - size; i--)
    if (turn[i]) {
      start = i
      break
    }
  if (start === 0)
    for (let i = target; i > 0; i--)
      if (step[i]) {
        start = i
        break
      }
  return { items: items.slice(start, end), before: start > 0 ? start : null }
}
