import { describe, expect, it, vi } from 'vitest'
import { refusedAnswer } from '../../../../../plugins/chat-view/src/refused-answer'

describe('what the dock does with a refused answer', () => {
  it('retires the card and says so when the host no longer holds the request', () => {
    const dispatch = vi.fn()
    const told = refusedAnswer(new Error('No such provider request.'), 'gone', dispatch)
    expect(dispatch).toHaveBeenCalledWith({ retire: 'gone' })
    expect(told).toBe('This request is no longer waiting.')
  })
  it('keeps the card and hands back any other failure as it came', () => {
    const dispatch = vi.fn()
    const failure = new Error('The server is stopping.')
    expect(refusedAnswer(failure, 'live', dispatch)).toBe(failure)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
