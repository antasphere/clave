import type { HistoryItem } from '../../../src/shared/session-model'
import type { LoggedEvent } from '../../../src/renderer/src/views/conversation-store'
import { emptyConversation, reduceConversation, type Conversation } from './reducer'

/** A log folded up to some point: the events it had then, and what they made. */
export interface Folded {
  events: LoggedEvent[]
  initial: Conversation['state']
  live: Conversation
}

/**
 * The host's log folded as it grows, never replayed. The log only ever
 * appends (`conversation-store.ts`: a new array holding the same events plus
 * the new one), so when `events` still holds the last event folded at the
 * same place, what was reduced stands and only the tail is applied; anything
 * else (a fresh subscription, a different start state) folds from the start.
 *
 * Replaying the whole log on each event made every streamed word cost the
 * length of the conversation, in a view kept mounted while hidden: on an
 * 800-turn session that was ~25ms a word, most of the main thread while an
 * answer streamed, and the composer of the view on screen lagged under the
 * reader's keys.
 */
export function foldLog(
  seen: Folded | null,
  events: LoggedEvent[],
  initial: Conversation['state']
): Folded {
  const extends_ =
    seen !== null &&
    seen.initial === initial &&
    events.length >= seen.events.length &&
    (seen.events.length === 0 ||
      events[seen.events.length - 1] === seen.events[seen.events.length - 1])
  const live = extends_
    ? events.slice(seen.events.length).reduce(reduceConversation, seen.live)
    : events.reduce(reduceConversation, { ...emptyConversation, state: initial })
  return { events, initial, live }
}

/** The past in front of what streamed since, so a row's key (`first + index`)
 *  holds as older pages arrive. `past` is reduced by the caller once per page. */
export function withPast(live: Conversation, past: Conversation): Conversation {
  if (!past.entries.length) return live
  return {
    ...live,
    entries: [...past.entries, ...live.entries],
    first: live.first - past.entries.length
  }
}

/** A page of the past, reduced on its own (main cuts pages where nothing pairs
 *  across the cut). */
export const reducePast = (past: HistoryItem[]): Conversation =>
  reduceConversation(emptyConversation, { prepend: past })
