import { describe, expect, it, vi } from 'vitest'
import { recentConversation } from './chat-reading'

const said = (text: string, at: number): { event: { type: string; text: string }; at: number } => ({
  event: { type: 'user_message', text },
  at
})

describe('what an agent reads of a chat (PRDCT-4664)', () => {
  it('reads the timeline, where what was said since a resume is, and hands on no position', async () => {
    // The legacy past stops at the resume; the timeline goes on after it.
    const history = vi.fn(() => ({ items: [said('before the resume', 1)] }))
    const items = await recentConversation(
      async () => ({
        items: [
          { ...said('before the resume', 1), position: { generation: 'g', sequence: 1 } },
          { ...said('since the resume', 2), position: { generation: 'g', sequence: 2 } }
        ]
      }),
      history
    )
    expect(items).toEqual([said('before the resume', 1), said('since the resume', 2)])
    expect(history).not.toHaveBeenCalled()
  })

  it.each([
    ['a host with no timeline answers null', async () => null],
    ['a host whose port is absent answers nothing', () => undefined],
    [
      'a timeline that cannot be read throws',
      async () => {
        throw new Error('The timeline could not be read')
      }
    ]
  ])('keeps the past when %s', async (_name, timeline) => {
    const items = await recentConversation(timeline, () => ({ items: [said('the past', 1)] }))
    expect(items).toEqual([said('the past', 1)])
  })

  it('leaves an event without a time without one', async () => {
    const items = await recentConversation(
      () => ({ items: [{ event: { type: 'assistant_text', delta: 'x', final: true } }] }),
      () => ({ items: [] })
    )
    expect(items).toEqual([{ event: { type: 'assistant_text', delta: 'x', final: true } }])
  })
})
