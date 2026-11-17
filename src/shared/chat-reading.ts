import { historyLines, type ReadableEvent } from './history-text'

/** One thing said or done in a conversation, as an agent is handed it. */
export interface Said<E> {
  readonly event: E
  readonly at?: number
}

type Answer<T> = T | Promise<T>
interface Page<E> {
  readonly items: readonly Said<E>[]
  /** Where the page before this one ends; null when nothing is older. */
  readonly before?: number | null
  /** A timeline's page names the process it was read from. */
  readonly cursor?: { readonly generation: string }
}

/** The most events one read of a chat goes back through: the most a page may
 *  hold (`HISTORY_PAGE_MAX`). */
export const CHAT_READ_EVENTS = 2000

/**
 * A chat's recent conversation as an agent reads it (`clave_read_session`,
 * on a Clave server, on the desktop's served road and on the window's): its
 * last `lines` lines, one per thing said or done (`historyLines`), and the
 * last `lines` events under them.
 *
 * Read where the chat's views read it, the session's timeline, which holds
 * the past the chat was resumed with and everything said since, in order.
 * The legacy past (`history`) is only what was said BEFORE this process: read
 * alone, a chat that had been resumed answered what it said before its resume
 * and nothing since, and a refusal said at start answered nothing at all
 * (PRDCT-4664). A host with no timeline (a server older than it) answers
 * null and keeps the past; a timeline that cannot be read is an error the
 * agent is told, never an empty conversation.
 *
 * The lines asked for are counted after the pieces of an answer are joined,
 * never in events: a page is cut by events and an answer streams as one
 * event per piece, so a hundred events of a chat in the middle of an answer
 * were the end of that answer and nothing of what led to it. The read starts
 * with a page of `lines` events, which is the whole of it for a conversation
 * at rest, and goes back a page at a time, each twice the last, until it
 * holds more lines than asked or has asked for `CHAT_READ_EVENTS` events. A
 * page read from another process than the first (a Resume landed between two
 * reads) is left out: its positions are another conversation's.
 */
export async function readChat<E extends ReadableEvent>(
  ports: {
    timeline: (before: number | undefined, limit: number) => Answer<Page<E> | null | undefined>
    history: (before: number | undefined, limit: number) => Answer<Page<E>>
  },
  lines: number
): Promise<{ lines: string[]; history: Said<E>[] }> {
  // Which of the two the host answers from is its first answer's word.
  let past = false
  const page = async (before: number | undefined, limit: number): Promise<Page<E>> => {
    if (!past) {
      const ordered = await ports.timeline(before, limit)
      if (ordered) return ordered
      // No timeline on a later page: the host's has gone, nothing older is read.
      if (before !== undefined) return { items: [], before: null }
      past = true
    }
    return ports.history(before, limit)
  }
  let said: Said<E>[] = []
  let text: string[] = []
  let before: number | undefined
  let limit = Math.min(Math.max(lines, 1), CHAT_READ_EVENTS)
  let asked = 0
  let generation: string | undefined
  for (;;) {
    const read = await page(before, limit)
    asked += limit
    if (before === undefined) generation = read.cursor?.generation
    else if (read.cursor?.generation !== generation) break
    // The position is the reader's business, not the agent's.
    said = [
      ...read.items.map(({ event, at }) => ({ event, ...(at !== undefined && { at }) })),
      ...said
    ]
    text = historyLines(said)
    const older = read.before
    if (
      // One line more than asked: the first line of what is held may be an
      // answer whose beginning is on the page before.
      text.length > lines ||
      asked >= CHAT_READ_EVENTS ||
      read.items.length === 0 ||
      older === null ||
      older === undefined ||
      // A cursor that does not move would ask the same page for ever.
      (before !== undefined && older >= before)
    )
      break
    before = older
    limit = Math.min(limit * 2, CHAT_READ_EVENTS - asked)
  }
  return { lines: text.slice(-lines), history: said.slice(-lines) }
}
