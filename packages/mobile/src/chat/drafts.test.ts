import { describe, expect, it } from 'vitest'
import { Drafts, MemoryKeyValueStore, draftKey } from './drafts'

describe('drafts', () => {
  it('survive a new instance over the same store, per machine and session', async () => {
    const store = new MemoryKeyValueStore()
    const drafts = new Drafts(store)
    await drafts.set('m1', 's1', 'half a thought')
    await drafts.set('m1', 's2', 'another')
    const again = new Drafts(store)
    expect(await again.get('m1', 's1')).toBe('half a thought')
    expect(await again.get('m1', 's2')).toBe('another')
    expect(await again.get('m2', 's1')).toBe('')
  })
  it('an empty text removes the draft from the store', async () => {
    const store = new MemoryKeyValueStore()
    const drafts = new Drafts(store)
    await drafts.set('m1', 's1', 'x')
    expect(store.map.has(draftKey('m1', 's1'))).toBe(true)
    await drafts.clear('m1', 's1')
    expect(store.map.has(draftKey('m1', 's1'))).toBe(false)
    expect(await drafts.get('m1', 's1')).toBe('')
  })
})
