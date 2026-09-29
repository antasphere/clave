import { expect, it } from 'vitest'
import type { LoggedEvent } from './conversation-store'
import { foldLog, reducePast, withPast } from '../../../../plugins/chat-view/src/fold-log'
import {
  emptyConversation,
  reduceConversation,
  type Conversation
} from '../../../../plugins/chat-view/src/reducer'

const log = (n: number, from = 0): LoggedEvent[] =>
  Array.from({ length: n }, (_, i) => ({
    event:
      (from + i) % 2 === 0
        ? { type: 'user_message', text: `q${from + i}` }
        : { type: 'assistant_text', delta: `a${from + i}`, final: true },
    at: from + i
  }))
const replay = (events: LoggedEvent[]): Conversation =>
  events.reduce(reduceConversation, { ...emptyConversation, state: 'idle' })

it('folds only what the log gained, and reads the same as a replay', () => {
  const first = log(40)
  const a = foldLog(null, first, 'idle')
  // The store appends by copying: same events, one more at the end.
  const grown = [...first, ...log(3, 40)]
  const b = foldLog(a, grown, 'idle')
  expect(b.live.entries).toEqual(replay(grown).entries)
  // What was folded stands: the entries already there are the same objects,
  // which a replay would have rebuilt.
  expect(b.live.entries[0]).toBe(a.live.entries[0])
  expect(b.live.entries[38]).toBe(a.live.entries[38])
})

it('folds from the start when the log is not the one it folded', () => {
  const a = foldLog(null, log(10), 'idle')
  // A fresh subscription: other events, or fewer.
  const other = log(4, 100)
  expect(foldLog(a, other, 'idle').live.entries).toEqual(replay(other).entries)
  expect(foldLog(a, log(10).slice(0, 5), 'idle').live.entries).toHaveLength(5)
  // A different start state is a different fold.
  expect(foldLog(a, a.events, 'working').live.state).toBe('working')
})

it('puts the past in front, keeping each entry its ordinal', () => {
  const live = foldLog(null, log(4), 'idle').live
  const past = reducePast(log(6, 50).map(({ event, at }) => ({ event, at })))
  const joined = withPast(live, past)
  expect(joined.entries.slice(0, 6)).toEqual(past.entries)
  expect(joined.first).toBe(live.first - 6)
  expect(withPast(live, reducePast([]))).toBe(live)
})
