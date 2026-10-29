import { describe, expect, it } from 'vitest'
import {
  applyFirstPage,
  mergeBufferedHistory,
  applyOlderPage,
  freshCursor,
  hasMore,
  shouldLoadOlder
} from './history'
import { emptyConversation } from './reducer'

describe('the page cursor', () => {
  it('the first page sets the cursor and the conversation', () => {
    const { conversation, cursor } = applyFirstPage(emptyConversation, {
      items: [{ event: { type: 'user_message', text: 'latest' } }],
      before: 200
    })
    expect(conversation.entries).toHaveLength(1)
    expect(cursor).toEqual({ before: 200, loaded: true, loading: false })
    expect(hasMore(cursor)).toBe(true)
    expect(shouldLoadOlder(cursor)).toBe(true)
    expect(shouldLoadOlder({ ...cursor, loading: true })).toBe(false)
  })
  it('an older page goes in front and the cursor moves back until null', () => {
    const first = applyFirstPage(emptyConversation, {
      items: [{ event: { type: 'user_message', text: 'latest' } }],
      before: 200
    })
    const older = applyOlderPage(first.conversation, {
      items: [{ event: { type: 'user_message', text: 'earlier' } }],
      before: null
    })
    expect(older.conversation.entries.map((e) => (e.kind === 'user' ? e.text : ''))).toEqual([
      'earlier',
      'latest'
    ])
    expect(older.conversation.first).toBe(-1)
    expect(hasMore(older.cursor)).toBe(false)
  })
  it('nothing loads before the first page', () => {
    expect(hasMore(freshCursor)).toBe(false)
    expect(shouldLoadOlder(freshCursor)).toBe(false)
  })
})

it('merges only ordered overlap between history and buffered stream, keeping distinct live events', () => {
  const item = (text: string): import('../contract/types').HistoryItem => ({
    event: { type: 'user_message' as const, text }
  })
  expect(
    mergeBufferedHistory({ items: [item('old'), item('a')], before: 2 }, [item('a'), item('b')])
  ).toEqual({ items: [item('old'), item('a'), item('b')], before: 2 })
  expect(mergeBufferedHistory({ items: [item('old')], before: null }, [item('a')]).items).toEqual([
    item('old'),
    item('a')
  ])
})
