import { describe, expect, it, vi } from 'vitest'
import { typingWriter } from '../../../../plugins/chat-view/src/question-context'

/* PRDCT-4210: the one way both views send a form's typing. */
describe('typingWriter', () => {
  it('records the sent fields in the view before it writes them, and swallows a refusal', async () => {
    const order: string[] = []
    const dispatch = vi.fn(() => {
      order.push('dispatch')
    })
    const write = vi.fn(async () => {
      order.push('write')
      throw new Error('settled')
    })
    typingWriter(dispatch, write)('clave:f', { name: 'Luca P' })
    await Promise.resolve()
    expect(dispatch).toHaveBeenCalledWith({ typedSent: 'clave:f', answers: { name: 'Luca P' } })
    expect(write).toHaveBeenCalledWith({
      type: 'permission_draft',
      id: 'clave:f',
      answers: { name: 'Luca P' }
    })
    expect(order).toEqual(['dispatch', 'write'])
  })
})
