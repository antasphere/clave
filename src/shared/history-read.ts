import { readHistory, type HistoryReading, type ReadableEvent } from './history-text'

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
 * so the oldest line read is a whole one. A status card's lines count as
 * lines (PRDCT-5166).
 *
 * With them, the status the last agent message ended on, read from the same
 * pages, so the lines and the status never disagree: every road answers both
 * from this one read.
 */
export async function readChatHistory(
  read: (before?: number, limit?: number) => ReadableHistoryPage | Promise<ReadableHistoryPage>,
  lines: number
): Promise<HistoryReading> {
  let items: ReadonlyArray<{ readonly event: ReadableEvent }> = []
  let before: number | undefined
  let reading: HistoryReading = { lines: [], status: null }
  for (let pages = 0; pages < READ_PAGES; pages++) {
    const page = await read(before, READ_PAGE)
    items = [...page.items, ...items]
    reading = readHistory(items)
    if (page.before === null || reading.lines.length >= lines) break
    before = page.before
  }
  return { lines: reading.lines.slice(-lines), status: reading.status }
}

/** The lines of `readChatHistory` alone. */
export async function readHistoryLines(
  read: (before?: number, limit?: number) => ReadableHistoryPage | Promise<ReadableHistoryPage>,
  lines: number
): Promise<string[]> {
  return (await readChatHistory(read, lines)).lines
}
