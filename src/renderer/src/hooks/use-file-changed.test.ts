import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => unknown>
}))
// The real hook without a DOM: ref slots kept by call order, the effects
// collected and run by the test, which keeps their cleanups to unmount.
vi.mock('react', () => ({
  useRef: <T>(initial: T): { current: T } => {
    const slot = hooks.cursor++
    if (!(slot in hooks.values)) hooks.values[slot] = { current: initial }
    return hooks.values[slot] as { current: T }
  },
  useEffect: (fn: () => unknown): void => {
    hooks.effects.push(fn)
  }
}))

let mod: typeof import('./use-file-changed')
let watchSet: { resolve: () => void; reject: (error: Error) => void }
let api: {
  watchClaveFile: ReturnType<typeof vi.fn>
  unwatchClaveFile: ReturnType<typeof vi.fn>
  onClaveFileChanged: ReturnType<typeof vi.fn>
}

beforeEach(async () => {
  // A fresh registry per test: it is a module-level singleton.
  vi.resetModules()
  mod = await import('./use-file-changed')
  hooks.values = []
  hooks.cursor = 0
  hooks.effects = []
  api = {
    // Resolves late, like a watch asked of a server apart from the app.
    watchClaveFile: vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          watchSet = { resolve, reject }
        })
    ),
    unwatchClaveFile: vi.fn(async () => {}),
    onClaveFileChanged: vi.fn(() => () => {})
  }
  vi.stubGlobal('window', { electronAPI: api })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/** Renders the hook once and runs its effects; returns the unmount. */
function mount(onChange: () => void, options?: { reconcile?: boolean }): () => void {
  hooks.cursor = 0
  hooks.effects = []
  mod.useFileChanged('/work/notes.md', onChange, options)
  const cleanups = hooks.effects
    .map((effect) => effect())
    .filter((c): c is () => void => typeof c === 'function')
  return () => cleanups.forEach((cleanup) => cleanup())
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

it('with reconcile, calls onChange once after the watch is set, not before', async () => {
  const onChange = vi.fn()
  mount(onChange, { reconcile: true })
  expect(api.watchClaveFile).toHaveBeenCalledWith('/work/notes.md')
  await flush()
  expect(onChange).not.toHaveBeenCalled()
  watchSet.resolve()
  await flush()
  expect(onChange).toHaveBeenCalledTimes(1)
  await flush()
  expect(onChange).toHaveBeenCalledTimes(1)
})

it('without reconcile, never calls onChange when the watch is set', async () => {
  const onChange = vi.fn()
  mount(onChange)
  watchSet.resolve()
  await flush()
  expect(onChange).not.toHaveBeenCalled()
})

it('unmounted before the watch is set, never calls onChange', async () => {
  const onChange = vi.fn()
  const unmount = mount(onChange, { reconcile: true })
  unmount()
  watchSet.resolve()
  await flush()
  expect(onChange).not.toHaveBeenCalled()
})

it('a watch that could not be set calls nothing', async () => {
  const onChange = vi.fn()
  mount(onChange, { reconcile: true })
  watchSet.reject(new Error('refused'))
  await flush()
  expect(onChange).not.toHaveBeenCalled()
})

it('a second consumer of a watch already set reconciles at once, without asking again', async () => {
  const first = vi.fn()
  mount(first, { reconcile: true })
  watchSet.resolve()
  await flush()
  hooks.values = []
  const second = vi.fn()
  mount(second, { reconcile: true })
  await flush()
  expect(api.watchClaveFile).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledTimes(1)
  expect(first).toHaveBeenCalledTimes(1)
})
