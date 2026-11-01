import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SetStateAction } from 'react'
import { resourceKey } from '@clave/contract/fleet'

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => unknown>,
  reads: [] as Promise<unknown>[]
}))
// Exercise the real hook's effects and async callbacks without a DOM. Keep
// state/ref slots across renders, and observe discarded promises so a missing
// catch fails an assertion instead of leaking into the test runner.
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
  useRef: <T>(initial: T): { current: T } => {
    const slot = hooks.cursor++
    if (!(slot in hooks.values)) hooks.values[slot] = { current: initial }
    return hooks.values[slot] as { current: T }
  },
  useMemo: (create: () => unknown): unknown => create(),
  useCallback:
    (callback: (...args: unknown[]) => unknown) =>
    (...args: unknown[]): unknown => {
      const result = callback(...args)
      if (result instanceof Promise) {
        hooks.reads.push(result)
        void result.catch(() => {})
      }
      return result
    },
  useEffect: (effect: () => unknown): void => {
    hooks.effects.push(effect)
  }
}))
vi.mock('../store/session-store', () => ({
  useSessionStore: (select: (state: object) => unknown) =>
    select({ gitLivePollLimit: 0, gitLivePollAlways: false, focusedSessionId: null })
}))
vi.mock('../components/git/git-batch-context', () => ({ useGitBatch: () => ({ run: vi.fn() }) }))
let statusHook: typeof import('./use-multi-repo-status').useMultiRepoStatus

const root = resourceKey('file', 'server', '/repo')
let api: {
  getGitStatus: ReturnType<typeof vi.fn>
  discoverGitRepos: ReturnType<typeof vi.fn>
  getGitStatusBatch: ReturnType<typeof vi.fn>
}
beforeEach(async () => {
  vi.resetModules()
  ;({ useMultiRepoStatus: statusHook } = await import('./use-multi-repo-status'))
  hooks.values = []
  hooks.cursor = 0
  hooks.effects = []
  hooks.reads = []
  api = {
    getGitStatus: vi.fn().mockResolvedValue({ isRepo: true }),
    discoverGitRepos: vi
      .fn()
      .mockResolvedValue({ repos: [{ name: 'child', path: '/repo/child' }] }),
    getGitStatusBatch: vi
      .fn()
      .mockResolvedValue([{ path: '/repo/child', status: { isRepo: true } }])
  }
  vi.stubGlobal('window', { electronAPI: api })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function render(cwd = root): ReturnType<typeof statusHook> {
  hooks.cursor = 0
  hooks.effects = []
  return statusHook(cwd, true)
}
function read(cwd = root): Promise<unknown> {
  render(cwd)
  hooks.effects[0]()
  return hooks.reads.at(-1)!
}

it.each(['getGitStatus', 'discoverGitRepos', 'getGitStatusBatch'] as const)(
  'a first-read failure in %s resolves and hands the error display to the single-repo panel',
  async (method) => {
    api[method].mockRejectedValue(new Error('server unreachable'))
    expect(render().result).toEqual({ mode: 'loading' })
    await expect(read()).resolves.toBeUndefined()
    expect(render().result).toEqual({ mode: 'single' })
    expect(render().lastUpdated).toBeNull()
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      '[clave] git panel read failed',
      'server unreachable'
    )
  }
)
it('keeps the last multi reading and its timestamp when the next read fails', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000)
  await expect(read()).resolves.toBeUndefined()
  const before = render()
  expect(before.result.mode).toBe('multi')
  expect(before.lastUpdated).toBe(1000)
  vi.mocked(Date.now).mockReturnValue(2000)
  api.getGitStatus.mockRejectedValue(new Error('server unreachable'))
  await expect(read()).resolves.toBeUndefined()
  const after = render()
  expect(after.result).toBe(before.result)
  expect(after.lastUpdated).toBe(before.lastUpdated)
  expect(console.warn).toHaveBeenCalledTimes(1)
})
it('ignores a failed read after the panel has moved to another folder', async () => {
  let reject!: (error: Error) => void
  api.getGitStatus.mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail
    })
  )
  const previous = read()
  const nextRoot = resourceKey('file', 'server', '/other')
  api.getGitStatus.mockResolvedValue({ isRepo: false })
  api.discoverGitRepos.mockResolvedValue({ repos: [], truncated: false })
  await expect(read(nextRoot)).resolves.toBeUndefined()
  expect(render(nextRoot).result).toEqual({ mode: 'none' })
  reject(new Error('old folder is unreachable'))
  await expect(previous).resolves.toBeUndefined()
  expect(render(nextRoot).result).toEqual({ mode: 'none' })
  expect(console.warn).not.toHaveBeenCalled()
})
