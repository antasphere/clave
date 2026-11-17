import { describe, expect, it, vi } from 'vitest'
import { CHAT_READ_EVENTS, readChat } from './chat-reading'
import type { ReadableEvent } from './history-text'

type Item = { event: ReadableEvent; at?: number }

const you = (text: string, at?: number): Item => ({
  event: { type: 'user_message', text },
  ...(at !== undefined && { at })
})
const piece = (delta: string, final = false): Item => ({
  event: { type: 'assistant_text', delta, final }
})
const tool = (name: string): Item => ({ event: { type: 'tool_call', name } })

/** A host's pages over `items`, cut by events as the timeline cuts them:
 *  the page that ends where `before` does, `limit` events long. */
function pages(
  items: Item[]
): ReturnType<
  typeof vi.fn<
    (before: number | undefined, limit: number) => { items: Item[]; before: number | null }
  >
> {
  return vi.fn((before: number | undefined, limit: number) => {
    const end = before ?? items.length
    const start = Math.max(0, end - limit)
    return { items: items.slice(start, end), before: start === 0 ? null : start }
  })
}
const none = vi.fn(() => ({ items: [] as Item[], before: null }))

describe('what an agent reads of a chat (PRDCT-4664)', () => {
  it('reads the timeline, where what was said since a resume is, and hands on no position', async () => {
    // The legacy past stops at the resume; the timeline goes on after it.
    const history = vi.fn(() => ({ items: [you('before the resume', 1)], before: null }))
    const timeline = vi.fn(async () => ({
      items: [
        { ...you('before the resume', 1), position: { generation: 'g', sequence: 1 } },
        { ...you('since the resume', 2), position: { generation: 'g', sequence: 2 } }
      ],
      before: null
    }))
    const chat = await readChat({ timeline, history }, 100)
    expect(chat.lines).toEqual(['You: before the resume', 'You: since the resume'])
    expect(chat.history).toEqual([you('before the resume', 1), you('since the resume', 2)])
    // A conversation at rest is one read, of the lines asked for.
    expect(timeline.mock.calls).toEqual([[undefined, 100]])
    expect(history).not.toHaveBeenCalled()
  })

  it.each([
    ['answers null', async () => null],
    ['has no such port', () => undefined]
  ])('keeps the past when the host %s', async (_name, timeline) => {
    const history = vi.fn(() => ({ items: [you('the past', 1)], before: null }))
    const chat = await readChat({ timeline, history }, 100)
    expect(chat.lines).toEqual(['You: the past'])
    expect(history.mock.calls).toEqual([[undefined, 100]])
  })

  it('tells the agent a timeline that cannot be read, never an empty conversation', async () => {
    const history = vi.fn(() => ({ items: [], before: null }))
    await expect(
      readChat(
        {
          timeline: async () => {
            throw new Error('The timeline could not be read')
          },
          history
        },
        100
      )
    ).rejects.toThrow('The timeline could not be read')
    expect(history).not.toHaveBeenCalled()
  })

  it('counts the lines asked for after the pieces of an answer are joined, going back as far as that takes', async () => {
    // An answer streams as one event per piece: three hundred of them here.
    // Counted in events, two "lines" were the answer's last piece and the call.
    const items = [
      you('the question'),
      ...Array.from({ length: 300 }, (_, n) => piece(`w${n} `, n === 299)),
      tool('Read')
    ]
    const timeline = pages(items)
    const chat = await readChat({ timeline, history: none }, 2)
    expect(chat.lines).toHaveLength(2)
    expect(chat.lines[0]).toMatch(/^Agent: w0 w1 .* w299$/)
    expect(chat.lines[1]).toBe('Tool: Read')
    // It began with a page of the two lines asked for, and doubled from there.
    expect(timeline.mock.calls[0]).toEqual([undefined, 2])
    expect(timeline.mock.calls.length).toBeLessThan(12)
    // The events under the lines stay bounded by the same number.
    expect(chat.history).toHaveLength(2)
    expect(chat.history.at(-1)?.event).toMatchObject({ type: 'tool_call', name: 'Read' })
  })

  it('goes back no further than the most a page may hold', async () => {
    // An answer with no end in sight: five thousand pieces and nothing else.
    const timeline = pages(Array.from({ length: 5000 }, (_, n) => piece(`w${n} `)))
    const chat = await readChat({ timeline, history: none }, 50)
    expect(chat.lines).toHaveLength(1)
    // Each page twice the last, the last one cut to what is left of the bound.
    const asked = timeline.mock.calls.reduce((sum, [, limit]) => sum + limit, 0)
    expect(asked).toBe(CHAT_READ_EVENTS)
  })

  it('leaves out a page read from another process than the first', async () => {
    // A Resume landed between two reads: the older page is the new process's,
    // and its positions are not this conversation's.
    const timeline = vi
      .fn()
      .mockReturnValueOnce({
        items: [piece('the end.', true)],
        before: 5,
        cursor: { generation: 'the first' }
      })
      .mockReturnValue({
        items: [you('from another process')],
        before: null,
        cursor: { generation: 'another' }
      })
    const chat = await readChat({ timeline, history: none }, 10)
    expect(chat.lines).toEqual(['Agent: the end.'])
    expect(timeline).toHaveBeenCalledTimes(2)
  })

  it('stops on a host whose cursor does not move, or whose timeline goes away between two pages', async () => {
    const stuck = vi.fn(() => ({ items: [piece('again ')], before: 7 }))
    const first = await readChat({ timeline: stuck, history: none }, 10)
    expect(first.lines).toEqual(['Agent: again again'])
    expect(stuck).toHaveBeenCalledTimes(2)
    const gone = vi
      .fn()
      .mockReturnValueOnce({ items: [piece('end.', true)], before: 3 })
      .mockReturnValue(null)
    const history = vi.fn(() => ({ items: [you('the past')], before: null }))
    const second = await readChat({ timeline: gone, history }, 10)
    expect(second.lines).toEqual(['Agent: end.'])
    // The past is another conversation's shape: never mixed into a timeline's.
    expect(history).not.toHaveBeenCalled()
  })
})
