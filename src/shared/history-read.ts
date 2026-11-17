import { historyLines, type ReadableEvent } from './history-text'

/** A page of a chat's past, as either copy of the session model gives it. */
export interface ReadableHistoryPage {
  readonly items: ReadonlyArray<{ readonly event: ReadableEvent }>
  readonly before: number | null
}

/** Events per page the read asks for. */
const READ_PAGE = 200
/** The most pages one read takes, whatever it asks. */
const READ_PAGES = 25

/**
 * The last `lines` lines of a chat, as `clave_read_session` answers them
 * (PRDCT-4666): counted in lines, never in events (a streamed message is one
 * event per delta), read back page by page until enough lines are in hand or
 * the conversation's start is reached. A page never begins inside a message,
 * so the oldest line read is a whole one.
 */
export async function readHistoryLines(
  read: (before?: number, limit?: number) => ReadableHistoryPage | Promise<ReadableHistoryPage>,
  lines: number
): Promise<string[]> {
  let items: ReadonlyArray<{ readonly event: ReadableEvent }> = []
  let before: number | undefined
  for (let pages = 0; pages < READ_PAGES; pages++) {
    const page = await read(before, READ_PAGE)
    items = [...page.items, ...items]
    if (page.before === null || historyLines(items).length >= lines) break
    before = page.before
  }
  return historyLines(items).slice(-lines)
}
