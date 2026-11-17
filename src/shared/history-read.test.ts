import { describe, expect, it, vi, type Mock } from 'vitest'
import { readHistoryLines, type ReadableHistoryPage } from './history-read'
import type { ReadableEvent } from './history-text'

/** A conversation paged as a history read pages it: `size` events a page, newest last. */
const pager = (
  events: ReadableEvent[],
  size: number
): Mock<(before?: number) => ReadableHistoryPage> =>
  vi.fn((before?: number): ReadableHistoryPage => {
    const end = before ?? events.length
    const start = Math.max(0, end - size)
    return {
      items: events.slice(start, end).map((event) => ({ event })),
      before: start > 0 ? start : null
    }
  })

describe('a chat read as lines (PRDCT-4666)', () => {
  it('reads a streamed message as one whole Agent line', async () => {
    const events: ReadableEvent[] = [
      { type: 'user_message', text: 'hello' },
      ...['Hel', 'lo ', 'the', 're'].map((delta) => ({
        type: 'assistant_text',
        delta,
        final: false
      })),
      { type: 'assistant_text', delta: '', final: true }
    ]
    expect(await readHistoryLines(pager(events, 200), 10)).toEqual([
      'You: hello',
      'Agent: Hello there'
    ])
  })

  it('reads further pages back until it holds the lines asked for', async () => {
    // Each turn is many events and two lines: three lines need two pages of 200.
    const turn = (n: number): ReadableEvent[] => [
      { type: 'user_message', text: `question ${n}` },
      ...Array.from({ length: 249 }, () => ({ type: 'state_change' })),
      { type: 'assistant_text', delta: `answer ${n}`, final: true }
    ]
    const events = [0, 1, 2, 3].flatMap(turn)
    const read = pager(events, 200)
    expect(await readHistoryLines(read, 3)).toEqual([
      'Agent: answer 2',
      'You: question 3',
      'Agent: answer 3'
    ])
    expect(read.mock.calls.length).toBeGreaterThan(1)
    expect(read.mock.calls[0]).toEqual([undefined, 200])
  })

  it('reads on past a page left empty, as long as an older one is there', async () => {
    // A history page drops the live state, so a page can be empty with more before it.
    const read = vi.fn(
      (before?: number): ReadableHistoryPage =>
        before === undefined
          ? { items: [], before: 400 }
          : { items: [{ event: { type: 'user_message', text: 'older' } }], before: null }
    )
    expect(await readHistoryLines(read, 5)).toEqual(['You: older'])
    expect(read.mock.calls).toEqual([
      [undefined, 200],
      [400, 200]
    ])
  })

  it('stops at the start of the conversation, and after 25 pages at most', async () => {
    const short = pager([{ type: 'user_message', text: 'only' }], 200)
    expect(await readHistoryLines(short, 50)).toEqual(['You: only'])
    expect(short).toHaveBeenCalledTimes(1)
    const silent = pager(
      Array.from({ length: 10_000 }, () => ({ type: 'state_change' })),
      200
    )
    expect(await readHistoryLines(silent, 5)).toEqual([])
    expect(silent).toHaveBeenCalledTimes(25)
  })
})
