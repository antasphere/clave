import { describe, expect, it, vi } from 'vitest'
import { CHAT_READ_EVENTS, readChat } from './chat-reading'
import type { ReadableEvent } from './history-text'

const you = (text: string, at: number): { event: { type: string; text: string }; at: number } => ({
  event: { type: 'user_message', text },
  at
})
const piece = (
  delta: string,
  final = false
): { event: { type: string; delta: string; final: boolean } } => ({
  event: { type: 'assistant_text', delta, final }
})

describe('what an agent reads of a chat (PRDCT-4664)', () => {
  it('reads the timeline, where what was said since a resume is, and hands on no position', async () => {
    // The legacy past stops at the resume; the timeline goes on after it.
    const history = vi.fn(() => ({ items: [you('before the resume', 1)] }))
    const timeline = vi.fn(async () => ({
      items: [
        { ...you('before the resume', 1), position: { generation: 'g', sequence: 1 } },
        { ...you('since the resume', 2), position: { generation: 'g', sequence: 2 } }
      ]
    }))
    const chat = await readChat({ timeline, history }, 100)
    expect(chat.lines).toEqual(['You: before the resume', 'You: since the resume'])
    expect(chat.history).toEqual([you('before the resume', 1), you('since the resume', 2)])
    expect(timeline).toHaveBeenCalledWith(CHAT_READ_EVENTS)
    expect(history).not.toHaveBeenCalled()
  })

  it.each([
    ['answers null', async () => null],
    ['has no such port', () => undefined]
  ])('keeps the past when the host %s', async (_name, timeline) => {
    const history = vi.fn(() => ({ items: [you('the past', 1)] }))
    const chat = await readChat({ timeline, history }, 100)
    expect(chat.lines).toEqual(['You: the past'])
    expect(history).toHaveBeenCalledWith(CHAT_READ_EVENTS)
  })

  it('tells the agent a timeline that cannot be read, never an empty conversation', async () => {
    const history = vi.fn(() => ({ items: [] }))
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

  it('counts the lines asked for after the pieces of an answer are joined', async () => {
    // An answer streams as one event per piece: three hundred of them here.
    // Counted in events, two "lines" were the answer's last two pieces.
    const pieces = Array.from({ length: 300 }, (_, n) => piece(`w${n} `, n === 299))
    const items: { event: ReadableEvent; at?: number }[] = [
      you('the question', 1),
      ...pieces,
      { event: { type: 'tool_call', name: 'Read' } }
    ]
    const chat = await readChat({ timeline: () => ({ items }), history: () => ({ items: [] }) }, 2)
    expect(chat.lines).toHaveLength(2)
    expect(chat.lines[0]).toMatch(/^Agent: w0 w1 .* w299$/)
    expect(chat.lines[1]).toBe('Tool: Read')
    // The events under them stay bounded by the same number.
    expect(chat.history).toHaveLength(2)
    expect(chat.history.at(-1)?.event).toMatchObject({ type: 'tool_call', name: 'Read' })
  })
})
