import { beforeEach, describe, expect, it } from 'vitest'
import { rememberTab, rememberedTab } from './panel-tab'

/** The panel reopens on the tab it was left on, per routine. */
const data = new Map<string, string>()
beforeEach(() => {
  data.clear()
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    length: 0
  }
})

describe('the panel tab per routine', () => {
  it('opens on Report the first time', () => {
    expect(rememberedTab('a')).toBe('report')
  })
  it('reopens on the tab it was left on, each routine its own', () => {
    rememberTab('a', 'discussion')
    rememberTab('b', 'runs')
    expect(rememberedTab('a')).toBe('discussion')
    expect(rememberedTab('b')).toBe('runs')
  })
  it('reads anything that is not a tab, or a broken store, as Report', () => {
    data.set('clave.routines.panelTab', JSON.stringify({ a: 'nope' }))
    expect(rememberedTab('a')).toBe('report')
    data.set('clave.routines.panelTab', '{broken')
    expect(rememberedTab('a')).toBe('report')
  })
})
