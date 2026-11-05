import { describe, expect, it } from 'vitest'
import { EchoAdapter } from './echo-adapter'

/* The echo adapter is the end-to-end suite's provider. A view reopened on a
   session asks the adapter for its past; an adapter with none leaves the
   reopened view empty, which is what hid the reopen road from the suite. */

const spec = (id: string) => ({ id, cwd: '/tmp', command: [] as string[], env: {} }) as never

describe('echo adapter history', () => {
  it('keeps every event its stream carried, oldest first, for a view that opens later', () => {
    const adapter = new EchoAdapter()
    const handle = adapter.prepare(spec('s1'))
    adapter.ready(handle)
    adapter.inject('s1', {
      kind: 'event',
      event: { type: 'user_message', text: 'Keep my conversation readable.' }
    })
    adapter.inject('s1', {
      kind: 'event',
      event: { type: 'assistant_text', delta: 'I will report progress here.', final: true }
    })
    const types = adapter.history(handle).map((item) => item.event.type)
    expect(types).toEqual(['session_meta', 'effort', 'user_message', 'assistant_text'])
    expect(adapter.history(handle).every((item) => typeof item.at === 'number')).toBe(true)
  })

  it('hands out a copy, and forgets the past with the session', () => {
    const adapter = new EchoAdapter()
    const handle = adapter.prepare(spec('s2'))
    adapter.inject('s2', { kind: 'event', event: { type: 'user_message', text: 'one' } })
    const first = adapter.history(handle)
    first.length = 0
    expect(adapter.history(handle)).toHaveLength(1)
    adapter.kill(handle)
    expect(() => adapter.history(handle)).toThrow('Unknown echo session')
  })
})
