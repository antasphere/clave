import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SetStateAction } from 'react'
import type { GitStatusResult } from '../../../preload/index.d'

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => unknown>,
  cleanups: [] as Array<() => void>
}))
// The real hook without a DOM: state and ref slots kept by call order, the
// effects collected and run by the test, their cleanups kept for the end.
vi.mock('react', () => {
  const effect = (fn: () => unknown): void => {
    hooks.effects.push(fn)
  }
  return {
    useState: <T>(initial: T | (() => T)): [T, (next: SetStateAction<T>) => void] => {
      const slot = hooks.cursor++
      if (!(slot in hooks.values))
        hooks.values[slot] = typeof initial === 'function' ? (initial as () => T)() : initial
      return [
        hooks.values[slot] as T,
        (next) => {
          hooks.values[slot] =
            typeof next === 'function'
              ? (next as (previous: T) => T)(hooks.values[slot] as T)
              : next
        }
      ]
    },
    useRef: <T>(initial: T): { current: T } => {
      const slot = hooks.cursor++
      if (!(slot in hooks.values)) hooks.values[slot] = { current: initial }
      return hooks.values[slot] as { current: T }
    },
    useCallback: (callback: unknown) => callback,
    useEffect: effect,
    useLayoutEffect: effect
  }
})
vi.mock('../store/session-store', () => ({
  useSessionStore: (select: (state: object) => unknown) => select({ gitRefreshTrigger: 0 })
}))

let mod: typeof import('./use-git-status')
const A = '/ws/app'
const B = '/ws/lib'
const status = (branch: string): GitStatusResult =>
  ({ isRepo: true, branch }) as unknown as GitStatusResult
let api: { getGitStatus: ReturnType<typeof vi.fn>; gitFetch: ReturnType<typeof vi.fn> }

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  vi.resetModules()
  mod = await import('./use-git-status')
  hooks.values = []
  hooks.cursor = 0
  hooks.effects = []
  hooks.cleanups = []
  api = {
    getGitStatus: vi.fn((path: string) => Promise.resolve(status(`${path}-live`))),
    gitFetch: vi.fn().mockResolvedValue(undefined)
  }
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })
  vi.stubGlobal('window', {
    electronAPI: {
      ...api,
      onGitReposChanged: () => () => {},
      gitWatchRepos: vi.fn().mockResolvedValue([]),
      gitUnwatchRepos: vi.fn().mockResolvedValue(undefined)
    }
  })
})
afterEach(() => {
  for (const cleanup of hooks.cleanups) cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** Two passes, like React: a state set during render is read by the render
 *  that follows it at once. */
function render(cwd: string | null, active = true): ReturnType<typeof mod.useGitStatus> {
  hooks.cursor = 0
  hooks.effects = []
  mod.useGitStatus(cwd, active)
  hooks.cursor = 0
  hooks.effects = []
  return mod.useGitStatus(cwd, active)
}
/** Render and run every effect, keeping their cleanups. */
function mount(cwd: string | null, active = true): ReturnType<typeof mod.useGitStatus> {
  const result = render(cwd, active)
  for (const effect of hooks.effects) {
    const cleanup = effect()
    if (typeof cleanup === 'function') hooks.cleanups.push(cleanup as () => void)
  }
  return result
}

it('a folder never read loads at once', async () => {
  const first = mount(A)
  expect(first.status).toBeNull()
  expect(first.loading).toBe(true)
  expect(api.getGitStatus).toHaveBeenCalledWith(A)
  await vi.advanceTimersByTimeAsync(0)
  const after = render(A)
  expect(after.status).toEqual(status(`${A}-live`))
  expect(after.loading).toBe(false)
})

it('a primed status is shown at once, and the first read waits for the poll interval', async () => {
  mod.primeGitStatus(A, status('primed'))
  const first = mount(A)
  expect(first.status).toEqual(status('primed'))
  expect(first.loading).toBe(false)
  expect(api.getGitStatus).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(api.getGitStatus).toHaveBeenCalledWith(A)
  expect(render(A).status).toEqual(status(`${A}-live`))
})

it('a status older than the poll interval is read again at once', () => {
  mod.primeGitStatus(A, status('old'))
  vi.setSystemTime(100_000 + 6_000)
  const first = mount(A)
  expect(first.status).toEqual(status('old'))
  expect(api.getGitStatus).toHaveBeenCalledWith(A)
})

it('an inactive hook shows the cache and reads nothing', async () => {
  mod.primeGitStatus(A, status('primed'))
  vi.setSystemTime(100_000 + 60_000)
  const hidden = mount(A, false)
  expect(hidden.status).toEqual(status('primed'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(api.getGitStatus).not.toHaveBeenCalled()
  expect(api.gitFetch).not.toHaveBeenCalled()
})

it("a folder change shows that folder's last status during the same render", () => {
  mod.primeGitStatus(B, status('b-primed'))
  mount(A)
  const moved = render(B)
  expect(moved.status).toEqual(status('b-primed'))
  expect(moved.loading).toBe(false)
  const unknown = render('/ws/new')
  expect(unknown.status).toBeNull()
  expect(unknown.loading).toBe(true)
})
