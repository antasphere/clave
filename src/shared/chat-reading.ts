import { historyLines, type ReadableEvent } from './history-text'

/** One thing said or done in a conversation, as an agent is handed it. */
export interface Said<E> {
  readonly event: E
  readonly at?: number
}

type Answer<T> = T | Promise<T>
interface Page<E> {
  readonly items: readonly Said<E>[]
}

/** How many events one read asks for: the most a page may hold
 *  (`HISTORY_PAGE_MAX`). A page is cut by events and an answer streams as
 *  many of them as it has pieces, so the lines an agent asks for are counted
 *  after the pieces are joined, never before: asked for a hundred events, a
 *  chat in the middle of an answer gave the end of that answer and nothing
 *  of what led to it. */
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
 */
export async function readChat<E extends ReadableEvent>(
  ports: {
    timeline: (limit: number) => Answer<Page<E> | null | undefined>
    history: (limit: number) => Answer<Page<E>>
  },
  lines: number
): Promise<{ lines: string[]; history: Said<E>[] }> {
  const page = (await ports.timeline(CHAT_READ_EVENTS)) ?? (await ports.history(CHAT_READ_EVENTS))
  // The position is the reader's business, not the agent's.
  const said = page.items.map(({ event, at }) => ({ event, ...(at !== undefined && { at }) }))
  return { lines: historyLines(said).slice(-lines), history: said.slice(-lines) }
}
