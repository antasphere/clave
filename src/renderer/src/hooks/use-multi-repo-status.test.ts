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
vi.mock('./use-git-status', () => ({ primeGitStatus: vi.fn() }))
let statusHook: typeof import('./use-multi-repo-status').useMultiRepoStatus
let primeGitStatus: ReturnType<typeof vi.fn>

const root = resourceKey('file', 'server', '/repo')
const CHILD = '/repo/child'
const OTHER = '/repo/other'
const repoStatus = (branch: string): { isRepo: true; branch: string } => ({ isRepo: true, branch })

/** A promise the test resolves when it wants a stage to land. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: Error) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
/** Past the grace the first reading gives discovery before showing the root alone. */
const pastGrace = (): Promise<void> => new Promise((r) => setTimeout(r, 220))

let api: {
  getGitStatus: ReturnType<typeof vi.fn>
  discoverGitRepos: ReturnType<typeof vi.fn>
  getGitStatusBatch: ReturnType<typeof vi.fn>
}
let clock: number
beforeEach(async () => {
  vi.resetModules()
  ;({ useMultiRepoStatus: statusHook } = await import('./use-multi-repo-status'))
  ;({ primeGitStatus } = (await import('./use-git-status')) as unknown as {
    primeGitStatus: ReturnType<typeof vi.fn>
  })
  hooks.values = []
  hooks.cursor = 0
  hooks.effects = []
  hooks.reads = []
  // The freshness rule reads the clock: each test moves it by hand, and a
  // read is always older than the poll interval unless the test says so.
  clock = 100_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  api = {
    getGitStatus: vi.fn((path: string) =>
      Promise.resolve(path === root ? repoStatus('main') : repoStatus('child-main'))
    ),
    discoverGitRepos: vi.fn().mockResolvedValue({ repos: [{ name: 'child', path: CHILD }] }),
    getGitStatusBatch: vi.fn().mockResolvedValue([])
  }
  vi.stubGlobal('window', { electronAPI: api })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function render(cwd = root, active = true): ReturnType<typeof statusHook> {
  hooks.cursor = 0
  hooks.effects = []
  return statusHook(cwd, active)
}
/** Render, run the activation effect, hand back the read it started (if any). */
function read(cwd = root): Promise<unknown> {
  const before = hooks.reads.length
  render(cwd)
  hooks.effects[0]()
  return hooks.reads.length > before ? hooks.reads.at(-1)! : Promise.resolve('skipped')
}
/** A later read: the clock is moved past the poll interval first. */
function readLater(cwd = root): Promise<unknown> {
  clock += 10_000
  return read(cwd)
}

it.each(['getGitStatus', 'discoverGitRepos'] as const)(
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

it('publishes in stages: the root as soon as git answers, every row on discovery, each status as it lands', async () => {
  const discovery = deferred<{ repos: Array<{ name: string; path: string }> }>()
  const child = deferred<{ isRepo: true; branch: string }>()
  const other = deferred<{ isRepo: true; branch: string }>()
  api.discoverGitRepos.mockReturnValue(discovery.promise)
  api.getGitStatus.mockImplementation((path: string) => {
    if (path === root) return Promise.resolve(repoStatus('main'))
    if (path === CHILD) return child.promise
    return other.promise
  })
  const whole = read()
  await settle()
  // Stage 1: the root is a repository; the single-repo panel can open on it,
  // primed with the status in hand, once discovery has had its grace.
  expect(primeGitStatus).toHaveBeenCalledWith(root, repoStatus('main'))
  expect(render().result).toEqual({ mode: 'loading' })
  await pastGrace()
  expect(render().result).toEqual({ mode: 'single' })
  expect(render().lastUpdated).toBeNull()

  // Stage 2: discovery names the rows, in its order, each without a status.
  discovery.resolve({
    repos: [
      { name: 'child', path: CHILD },
      { name: 'other', path: OTHER }
    ]
  })
  await settle()
  const listed = render()
  expect(listed.result).toEqual({
    mode: 'multi',
    repos: [
      { name: 'repo', path: root, status: repoStatus('main'), worktreeOf: null },
      { name: 'child', path: CHILD, status: null, worktreeOf: null },
      { name: 'other', path: OTHER, status: null, worktreeOf: null }
    ],
    truncated: false,
    live: false
  })
  expect(listed.hasNestedRepos).toBe(true)
  expect(listed.lastUpdated).toBeNull()

  // Stage 3: the second row answers first; the rows keep their order.
  other.resolve(repoStatus('other-main'))
  await settle()
  const partial = render().result
  expect(partial.mode).toBe('multi')
  if (partial.mode !== 'multi') throw new Error('unreachable')
  expect(partial.repos.map((r) => [r.name, r.status?.branch ?? null])).toEqual([
    ['repo', 'main'],
    ['child', null],
    ['other', 'other-main']
  ])
  expect(render().lastUpdated).toBeNull()

  child.resolve(repoStatus('child-main'))
  await expect(whole).resolves.toBeUndefined()
  const full = render()
  expect(full.result.mode === 'multi' && full.result.repos.map((r) => r.status?.branch)).toEqual([
    'main',
    'child-main',
    'other-main'
  ])
  expect(full.lastUpdated).toBe(clock)
})

it('skips the single-repo stage when discovery answers within the grace', async () => {
  const child = deferred<{ isRepo: true; branch: string }>()
  api.getGitStatus.mockImplementation((path: string) =>
    path === root ? Promise.resolve(repoStatus('main')) : child.promise
  )
  const seen: string[] = []
  const whole = read()
  // Discovery answers at once (a cached scan): the list is the first thing
  // published, never the single-repo panel.
  for (let i = 0; i < 5; i++) {
    await settle()
    seen.push(render().result.mode)
  }
  await pastGrace()
  seen.push(render().result.mode)
  expect(seen).not.toContain('single')
  expect(render().result.mode).toBe('multi')
  child.resolve(repoStatus('child-main'))
  await expect(whole).resolves.toBeUndefined()
})

it('skips the single-repo stage when discovery answers late but still within the grace', async () => {
  // A scan that takes real time, well under the grace: the microtask case
  // above would pass with a grace of zero; this one does not.
  const child = deferred<{ isRepo: true; branch: string }>()
  api.getGitStatus.mockImplementation((path: string) =>
    path === root ? Promise.resolve(repoStatus('main')) : child.promise
  )
  api.discoverGitRepos.mockImplementation(
    () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ repos: [{ name: 'child', path: CHILD }] }), 50)
      )
  )
  const whole = read()
  const seen: string[] = []
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 25))
    seen.push(render().result.mode)
  }
  await pastGrace()
  seen.push(render().result.mode)
  expect(seen).not.toContain('single')
  expect(render().result.mode).toBe('multi')
  child.resolve(repoStatus('child-main'))
  await expect(whole).resolves.toBeUndefined()
})

it('writes a late status of a folder the panel has left into neither list nor cache', async () => {
  // Folder A lists one child; folder B lists the same child path and another.
  // A's child status lands after the move to B: B's list and A's cache must
  // both be as if it never came.
  const aChild = deferred<{ isRepo: true; branch: string }>()
  api.getGitStatus.mockImplementation((path: string) =>
    path === root ? Promise.resolve({ isRepo: false }) : aChild.promise
  )
  const previous = read()
  await settle()
  expect(render().result.mode).toBe('multi')
  const nextRoot = resourceKey('file', 'server', '/other')
  api.getGitStatus.mockImplementation((path: string) =>
    path === nextRoot ? Promise.resolve({ isRepo: false }) : Promise.resolve(repoStatus('b-main'))
  )
  api.discoverGitRepos.mockResolvedValue({
    repos: [
      { name: 'child', path: CHILD },
      { name: 'other', path: OTHER }
    ],
    truncated: false
  })
  await expect(read(nextRoot)).resolves.toBeUndefined()
  const b = render(nextRoot).result
  expect(b.mode === 'multi' && b.repos.map((r) => r.status?.branch)).toEqual(['b-main', 'b-main'])
  aChild.resolve(repoStatus('a-main'))
  await expect(previous).resolves.toBeUndefined()
  const bAfter = render(nextRoot).result
  expect(bAfter).toBe(b)
  // Back on A: its cache holds its own one-row list, the child still unread.
  clock += 10_000
  const cachedA = render(root)
  hooks.effects[0]()
  const a = render(root).result
  expect(a.mode === 'multi' && a.repos.map((r) => [r.path, r.status])).toEqual([[CHILD, null]])
  expect(cachedA.result.mode).toBe('multi')
})

it('carries the worktree source discovery read, so a worktree row hangs under its repository before its status', async () => {
  api.getGitStatus.mockResolvedValue({ isRepo: false })
  api.discoverGitRepos.mockResolvedValue({
    repos: [
      { name: 'app', path: '/repo/app' },
      { name: 'wt-lane', path: '/repo/wt-lane', worktreeOf: '/repo/app' }
    ],
    truncated: false
  })
  await expect(read()).resolves.toBeUndefined()
  const result = render().result
  expect(result.mode === 'multi' && result.repos.map((r) => [r.name, r.worktreeOf])).toEqual([
    ['app', null],
    ['wt-lane', '/repo/app']
  ])
})

it('lists the rows of a folder that is not itself a repository before any status is read', async () => {
  const child = deferred<{ isRepo: true; branch: string }>()
  api.getGitStatus.mockImplementation((path: string) =>
    path === root ? Promise.resolve({ isRepo: false }) : child.promise
  )
  const whole = read()
  await settle()
  expect(render().result).toEqual({
    mode: 'multi',
    repos: [{ name: 'child', path: CHILD, status: null, worktreeOf: null }],
    truncated: undefined,
    live: false
  })
  expect(render().hasNestedRepos).toBe(false)
  child.resolve(repoStatus('child-main'))
  await expect(whole).resolves.toBeUndefined()
  const full = render().result
  expect(full.mode === 'multi' && full.repos[0].status).toEqual(repoStatus('child-main'))
})

it("keeps each row's last status while a new reading of it is on its way", async () => {
  await expect(read()).resolves.toBeUndefined()
  const child = deferred<{ isRepo: true; branch: string }>()
  api.getGitStatus.mockImplementation((path: string) =>
    path === root ? Promise.resolve(repoStatus('main')) : child.promise
  )
  const again = readLater()
  await settle()
  const during = render().result
  expect(during.mode === 'multi' && during.repos[1].status).toEqual(repoStatus('child-main'))
  child.resolve(repoStatus('child-next'))
  await expect(again).resolves.toBeUndefined()
  const after = render().result
  expect(after.mode === 'multi' && after.repos[1].status).toEqual(repoStatus('child-next'))
})

it('leaves a row in its reading state when its own read fails, and says which', async () => {
  api.getGitStatus.mockImplementation((path: string) =>
    path === root ? Promise.resolve(repoStatus('main')) : Promise.reject(new Error('index locked'))
  )
  await expect(read()).resolves.toBeUndefined()
  const result = render().result
  expect(result.mode === 'multi' && result.repos[1].status).toBeNull()
  expect(console.warn).toHaveBeenCalledExactlyOnceWith(
    '[clave] git repo read failed',
    CHILD,
    'index locked'
  )
  expect(render().lastUpdated).toBe(clock)
})

it('does not read again when the last reading is younger than the poll interval', async () => {
  await expect(read()).resolves.toBeUndefined()
  const calls = api.getGitStatus.mock.calls.length
  clock += 2_000
  await expect(read()).resolves.toBe('skipped')
  expect(api.getGitStatus).toHaveBeenCalledTimes(calls)
  clock += 4_000
  await expect(read()).resolves.toBeUndefined()
  expect(api.getGitStatus.mock.calls.length).toBeGreaterThan(calls)
})

it('shows the last reading and reads nothing while the pane is inactive', async () => {
  await expect(read()).resolves.toBeUndefined()
  const calls = api.getGitStatus.mock.calls.length
  clock += 10_000
  const before = hooks.reads.length
  const hidden = render(root, false)
  hooks.effects[0]()
  expect(hidden.result.mode).toBe('multi')
  expect(hooks.reads.length).toBe(before)
  expect(api.getGitStatus).toHaveBeenCalledTimes(calls)
})

it('keeps the last multi reading and its timestamp when the next read fails', async () => {
  await expect(read()).resolves.toBeUndefined()
  const before = render()
  expect(before.result.mode).toBe('multi')
  expect(before.lastUpdated).toBe(clock)
  api.getGitStatus.mockRejectedValue(new Error('server unreachable'))
  await expect(readLater()).resolves.toBeUndefined()
  const after = render()
  expect(after.result).toBe(before.result)
  expect(after.lastUpdated).toBe(before.lastUpdated)
  expect(console.warn).toHaveBeenCalledTimes(1)
})

it('ignores a failed read after the panel has moved to another folder', async () => {
  const pending = deferred<{ isRepo: boolean }>()
  api.getGitStatus.mockReturnValueOnce(pending.promise)
  const previous = read()
  const nextRoot = resourceKey('file', 'server', '/other')
  api.getGitStatus.mockResolvedValue({ isRepo: false })
  api.discoverGitRepos.mockResolvedValue({ repos: [], truncated: false })
  await expect(read(nextRoot)).resolves.toBeUndefined()
  expect(render(nextRoot).result).toEqual({ mode: 'none' })
  pending.reject(new Error('old folder is unreachable'))
  await expect(previous).resolves.toBeUndefined()
  expect(render(nextRoot).result).toEqual({ mode: 'none' })
  expect(console.warn).not.toHaveBeenCalled()
})

it('drops a status that lands for a folder the panel has left', async () => {
  const child = deferred<{ isRepo: true; branch: string }>()
  api.getGitStatus.mockImplementation((path: string) =>
    path === root ? Promise.resolve(repoStatus('main')) : child.promise
  )
  const previous = read()
  await settle()
  expect(render().result.mode).toBe('multi')
  const nextRoot = resourceKey('file', 'server', '/other')
  api.getGitStatus.mockResolvedValue({ isRepo: false })
  api.discoverGitRepos.mockResolvedValue({ repos: [], truncated: false })
  await expect(read(nextRoot)).resolves.toBeUndefined()
  child.resolve(repoStatus('child-main'))
  await expect(previous).resolves.toBeUndefined()
  expect(render(nextRoot).result).toEqual({ mode: 'none' })
})
