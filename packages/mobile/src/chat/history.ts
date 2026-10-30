/**
 * The page cursor of a conversation's past. The server answers the newest
 * page first (`GET /sessions/history` without `before`), each page oldest
 * event first, with `before` naming where the page before it ends and
 * `null` when there is none: the first page replaces what the phone holds
 * (`sync`), every further page goes in front (`prepend`), one at a time.
 * The desktop's `earlier.ts` drives this from the scroll position; the
 * phone's list asks when the reader reaches the top.
 */
import type { HistoryPage, HistoryItem, SessionPosition, TimelinePage } from '../contract/types'
import { type Action, type Conversation, reduceConversation } from './reducer'

export interface HistoryCursor {
  /** Where the next older page ends; null when the past is all here. */
  readonly before: number | null
  /** The first page has landed. */
  readonly loaded: boolean
  /** A page is on its way. */
  readonly loading: boolean
}

export const freshCursor: HistoryCursor = { before: null, loaded: false, loading: false }

export const hasMore = (cursor: HistoryCursor): boolean => cursor.loaded && cursor.before !== null

/** The first page: the conversation rebuilt from it, the cursor set. */
export function applyFirstPage(
  conversation: Conversation,
  page: HistoryPage
): { conversation: Conversation; cursor: HistoryCursor } {
  const action: Action = { sync: page.items }
  return {
    conversation: page.items.length ? reduceConversation(conversation, action) : conversation,
    cursor: { before: page.before, loaded: true, loading: false }
  }
}

/** A further page, in front of what is here; the cursor moves back. */
export function applyOlderPage(
  conversation: Conversation,
  page: HistoryPage
): { conversation: Conversation; cursor: HistoryCursor } {
  const action: Action = { prepend: page.items }
  return {
    conversation: page.items.length ? reduceConversation(conversation, action) : conversation,
    cursor: { before: page.before, loaded: true, loading: false }
  }
}

/** Whether to ask for the page before the oldest one shown: only when the
 *  first page is here, the past is not all here, and no page is on its way. */
export const shouldLoadOlder = (cursor: HistoryCursor): boolean =>
  hasMore(cursor) && !cursor.loading

export type BufferedItem = HistoryItem & { readonly position?: SessionPosition }

export class TimelineChanged extends Error {
  constructor() {
    super('The conversation changed while history was loading. Refresh it again.')
  }
}

/** Only the server's positions establish identity. Identical text can be new. */
export function mergeBufferedHistory(
  page: TimelinePage,
  buffered: readonly BufferedItem[]
): HistoryPage {
  const seen = new Set<number>()
  const newer = buffered.filter((item) => {
    if (!item.position) return true // Synthetic prompt replay has no ordered identity.
    if (item.position.generation !== page.cursor.generation) throw new TimelineChanged()
    if (item.position.sequence <= page.cursor.sequence || seen.has(item.position.sequence))
      return false
    seen.add(item.position.sequence)
    return true
  })
  const ordered = newer
    .filter((item) => item.position)
    .sort((a, b) => a.position!.sequence - b.position!.sequence)
  let next = page.cursor.sequence + 1
  for (const item of ordered) {
    if (item.position!.sequence !== next++) throw new TimelineChanged()
  }
  return {
    items: [...page.items, ...ordered, ...newer.filter((item) => !item.position)],
    before: page.before
  }
}
