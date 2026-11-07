import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SetStateAction } from 'react'

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }))
// The real hook without a DOM: state slots kept by call order across renders.
vi.mock('react', () => ({
  useState: <T>(initial: T | (() => T)): [T, (next: SetStateAction<T>) => void] => {
    const slot = hooks.cursor++
    if (!(slot in hooks.values))
      hooks.values[slot] = typeof initial === 'function' ? (initial as () => T)() : initial
    return [
      hooks.values[slot] as T,
      (next) => {
        hooks.values[slot] =
          typeof next === 'function' ? (next as (previous: T) => T)(hooks.values[slot] as T) : next
      }
    ]
  },
  useCallback: (callback: unknown) => callback
}))

let mod: typeof import('./git-row-state')
beforeEach(async () => {
  vi.resetModules()
  mod = await import('./git-row-state')
  hooks.values = []
  hooks.cursor = 0
})
afterEach(() => mod.resetRowStates())

/** One mounted row: a fresh slot set, so a second call is a second mount. */
function mount(repoPath: string): () => ReturnType<typeof mod.useRowState> {
  const base = hooks.values.length
  const render = (): ReturnType<typeof mod.useRowState> => {
    hooks.cursor = base
    return mod.useRowState(repoPath)
  }
  render() // claim the slot now, so the next mount gets one of its own
  return render
}

describe('the row state of the git list (PRDCT-4142)', () => {
  it('starts closed with the local changes on, and a patch merges', () => {
    const render = mount('/ws/app')
    expect(render()[0]).toEqual(mod.ROW_DEFAULT)
    render()[1]({ incoming: true, expanded: true })
    expect(render()[0]).toEqual({ ...mod.ROW_DEFAULT, incoming: true, expanded: true })
    render()[1]((prev) => ({ expanded: !prev.expanded }))
    expect(render()[0].expanded).toBe(false)
    expect(render()[0].incoming).toBe(true)
  })

  it('a row mounted again for the same repository opens as it was left', () => {
    const first = mount('/ws/app')
    first()[1]({ expanded: true, outgoing: true })
    const again = mount('/ws/app')
    expect(again()[0]).toEqual({ ...mod.ROW_DEFAULT, expanded: true, outgoing: true })
    expect(mod.rememberedRowState('/ws/app').expanded).toBe(true)
  })

  it('keeps one state per repository', () => {
    const app = mount('/ws/app')
    const lib = mount('/ws/lib')
    app()[1]({ expanded: true })
    expect(lib()[0].expanded).toBe(false)
    expect(mod.rememberedRowState('/ws/lib')).toEqual(mod.ROW_DEFAULT)
  })

  it('never writes into the shared default', () => {
    const app = mount('/ws/app')
    app()[1]({ changes: false })
    expect(mod.ROW_DEFAULT.changes).toBe(true)
  })
})
