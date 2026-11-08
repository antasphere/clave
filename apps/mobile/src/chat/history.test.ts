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

it('keeps a new identical delta beyond the snapshot watermark', () => {
  const event = { type: 'assistant_text' as const, delta: 'a', final: false }
  const page = {
    items: [{ event, position: { generation: 'g', sequence: 1 } }],
    before: null,
    cursor: { generation: 'g', sequence: 1 },
    truncated: false
  }
  const joined = mergeBufferedHistory(page, [{ event, position: { generation: 'g', sequence: 2 } }])
  const applied = applyFirstPage(emptyConversation, joined)
  expect(applied.conversation.entries[0]).toMatchObject({ text: 'aa' })
})

it('deduplicates positions only and rejects generation changes or gaps', () => {
  const event = { type: 'assistant_text' as const, delta: 'a', final: false }
  const item = (sequence: number, generation = 'g'): import('../contract/types').TimelineItem => ({
    event,
    position: { generation, sequence }
  })
  const page = {
    items: [item(4)],
    cursor: { generation: 'g', sequence: 4 },
    before: null,
    truncated: true
  }
  expect(mergeBufferedHistory(page, [item(4), item(6), item(5), item(5)]).items).toEqual([
    item(4),
    item(5),
    item(6)
  ])
  expect(() => mergeBufferedHistory(page, [item(5, 'new')])).toThrow()
  expect(() => mergeBufferedHistory(page, [item(6)])).toThrow()
})
