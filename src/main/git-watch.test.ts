import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GitRepoWatcher, isRelevantChange, type RepoDirs, type WatchFn } from './git-watch'

/**
 * The repo watcher (PRDCT-3775): which changes can move a repo's status, and
 * how a burst of them reaches the panel — once, for the repos it touched.
 */

const main: RepoDirs = { root: '/w/app', gitDir: '/w/app/.git', commonDir: '/w/app/.git' }
const linked: RepoDirs = {
  root: '/w/wt-app',
  gitDir: '/w/app/.git/worktrees/wt-app',
  commonDir: '/w/app/.git'
}

describe('isRelevantChange', () => {
  it('reports work-tree edits and drops the ignored directories', () => {
    expect(isRelevantChange(main, '/w/app/src/a.ts', [])).toBe(true)
    expect(isRelevantChange(main, '/w/app/node_modules/x/index.js', [])).toBe(false)
    expect(isRelevantChange(main, '/w/app/dist/out.js', [])).toBe(false)
  })

  it('reports index, HEAD and ref moves, and drops objects, reflogs and locks', () => {
    expect(isRelevantChange(main, '/w/app/.git/index', [])).toBe(true)
    expect(isRelevantChange(main, '/w/app/.git/HEAD', [])).toBe(true)
    expect(isRelevantChange(main, '/w/app/.git/refs/heads/dev', [])).toBe(true)
    expect(isRelevantChange(main, '/w/app/.git/objects/ab/cdef', [])).toBe(false)
    expect(isRelevantChange(main, '/w/app/.git/logs/HEAD', [])).toBe(false)
    expect(isRelevantChange(main, '/w/app/.git/index.lock', [])).toBe(false)
  })

  it("leaves a main checkout's linked worktrees to themselves", () => {
    expect(isRelevantChange(main, '/w/app/.git/worktrees/wt-app/HEAD', [])).toBe(false)
    expect(isRelevantChange(linked, '/w/app/.git/worktrees/wt-app/HEAD', [])).toBe(true)
    expect(isRelevantChange(linked, '/w/app/.git/worktrees/wt-app/index', [])).toBe(true)
  })

  it('gives a linked worktree the shared refs and nothing else of the common dir', () => {
    expect(isRelevantChange(linked, '/w/app/.git/refs/remotes/origin/dev', [])).toBe(true)
    expect(isRelevantChange(linked, '/w/app/.git/packed-refs', [])).toBe(true)
    expect(isRelevantChange(linked, '/w/app/.git/FETCH_HEAD', [])).toBe(true)
    expect(isRelevantChange(linked, '/w/app/.git/index', [])).toBe(false)
    expect(isRelevantChange(linked, '/w/app/.git/HEAD', [])).toBe(false)
    expect(isRelevantChange(linked, '/w/app/.git/worktrees/other/HEAD', [])).toBe(false)
  })

  it("leaves a watched nested repo's changes to the nested repo", () => {
    const outer: RepoDirs = { root: '/w', gitDir: '/w/.git', commonDir: '/w/.git' }
    expect(isRelevantChange(outer, '/w/app/src/a.ts', ['/w', '/w/app'])).toBe(false)
    expect(isRelevantChange(outer, '/w/README.md', ['/w', '/w/app'])).toBe(true)
    // An unwatched nested repo's own git dir never reaches the outer one.
    expect(isRelevantChange(outer, '/w/other/.git/index', ['/w'])).toBe(false)
  })

  it('ignores paths outside the repo', () => {
    expect(isRelevantChange(main, '/w/appendix/file', [])).toBe(false)
  })
})

describe('GitRepoWatcher', () => {
  type Listener = (filename: string | null) => void
  let listeners: Map<string, Listener[]>
  let closed: string[]
  let changes: string[][]
  let failing: Set<string>

  const watch: WatchFn = (dir, onEvent) => {
    if (failing.has(dir)) throw new Error('EMFILE')
    const list = listeners.get(dir) ?? []
    list.push(onEvent)
    listeners.set(dir, list)
    return {
      close: () => {
        closed.push(dir)
        listeners.set(
          dir,
          (listeners.get(dir) ?? []).filter((l) => l !== onEvent)
        )
      }
    }
  }
  const emit = (dir: string, filename: string | null): void => {
    for (const l of listeners.get(dir) ?? []) l(filename)
  }
  const dirsOf: Record<string, RepoDirs> = {
    '/w/app': main,
    '/w/wt-app': linked,
    '/w/lib': { root: '/w/lib', gitDir: '/w/lib/.git', commonDir: '/w/lib/.git' }
  }
  const make = (): GitRepoWatcher =>
    new GitRepoWatcher({
      watch,
      resolve: async (repo) => dirsOf[repo] ?? null,
      onChange: (repos) => changes.push(repos.sort()),
      debounceMs: 300,
      maxWaitMs: 1500
    })

  beforeEach(() => {
    vi.useFakeTimers()
    listeners = new Map()
    closed = []
    changes = []
    failing = new Set()
  })
  afterEach(() => vi.useRealTimers())

  it('reports a burst once, with every repo it touched', async () => {
    const w = make()
    expect(await w.setRepos('win1:panel', ['/w/app', '/w/lib'])).toEqual(['/w/app', '/w/lib'])
    emit('/w/app', 'src/a.ts')
    emit('/w/app', 'src/b.ts')
    emit('/w/lib', 'index.ts')
    emit('/w/app', '.git/objects/aa/bb')
    vi.advanceTimersByTime(299)
    expect(changes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(changes).toEqual([['/w/app', '/w/lib']])
  })

  it('reports within the longest wait while changes keep coming', async () => {
    const w = make()
    await w.setRepos('win1:panel', ['/w/app'])
    for (let i = 0; i < 10; i++) {
      emit('/w/app', `src/f${i}.ts`)
      vi.advanceTimersByTime(200)
    }
    expect(changes.length).toBeGreaterThanOrEqual(1)
    expect(changes[0]).toEqual(['/w/app'])
  })

  it('watches a linked worktree where its git dirs live too', async () => {
    const w = make()
    await w.setRepos('win1:panel', ['/w/wt-app'])
    expect([...listeners.keys()].sort()).toEqual(['/w/app/.git', '/w/wt-app'])
    emit('/w/app/.git', 'refs/remotes/origin/dev')
    vi.advanceTimersByTime(300)
    expect(changes).toEqual([['/w/wt-app']])
    emit('/w/app/.git', 'index')
    vi.advanceTimersByTime(300)
    expect(changes).toEqual([['/w/wt-app']])
  })

  it('shares one watch between subscribers and closes it with the last one', async () => {
    const w = make()
    await w.setRepos('win1:a', ['/w/app'])
    await w.setRepos('win2:b', ['/w/app'])
    expect(listeners.get('/w/app')?.length).toBe(1)
    w.drop('win1:a')
    expect(closed).toEqual([])
    w.dropPrefix('win2:')
    expect(closed).toEqual(['/w/app'])
    expect(w.watchedRepos()).toEqual([])
  })

  it('replaces a subscriber set and releases what left it', async () => {
    const w = make()
    await w.setRepos('win1:a', ['/w/app', '/w/lib'])
    expect(await w.setRepos('win1:a', ['/w/lib'])).toEqual(['/w/lib'])
    expect(closed).toEqual(['/w/app'])
  })

  it('leaves out what it cannot watch, for the panel to poll', async () => {
    failing.add('/w/lib')
    const w = make()
    expect(await w.setRepos('win1:a', ['/w/app', '/w/lib', '/w/none'])).toEqual(['/w/app'])
  })

  it('stops reporting a repo nobody watches any more', async () => {
    const w = make()
    await w.setRepos('win1:a', ['/w/app'])
    emit('/w/app', 'src/a.ts')
    w.drop('win1:a')
    vi.advanceTimersByTime(2000)
    expect(changes).toEqual([])
  })

  it('watches nothing for a subscriber dropped while it subscribed', async () => {
    let release!: () => void
    const slow = new Promise<void>((r) => (release = r))
    const w = new GitRepoWatcher({
      watch,
      resolve: async (repo) => {
        if (repo === '/w/app') await slow
        return dirsOf[repo] ?? null
      },
      onChange: (repos) => changes.push(repos),
      debounceMs: 300,
      maxWaitMs: 1500
    })
    await w.setRepos('win2:other', ['/w/lib'])
    const pending = w.setRepos('win1:a', ['/w/app', '/w/lib'])
    w.drop('win1:a')
    release()
    expect(await pending).toEqual([])
    w.drop('win2:other')
    expect(w.watchedRepos()).toEqual([])
    expect(listeners.get('/w/app') ?? []).toEqual([])
  })

  it('answers nothing to a set replaced while it resolved, and keeps the new one', async () => {
    let release!: () => void
    const slow = new Promise<void>((r) => (release = r))
    const w = new GitRepoWatcher({
      watch,
      resolve: async (repo) => {
        if (repo === '/w/app') await slow
        return dirsOf[repo] ?? null
      },
      onChange: (repos) => changes.push(repos),
      debounceMs: 300,
      maxWaitMs: 1500
    })
    const first = w.setRepos('win1:a', ['/w/app'])
    const second = w.setRepos('win1:a', ['/w/lib'])
    release()
    expect(await first).toEqual([])
    expect(await second).toEqual(['/w/lib'])
    expect(w.watchedRepos()).toEqual(['/w/lib'])
  })

  it('reports an exclude-file edit and a shared upstream change', () => {
    expect(isRelevantChange(main, '/w/app/.git/info/exclude', [])).toBe(true)
    expect(isRelevantChange(linked, '/w/app/.git/config', [])).toBe(true)
  })
})
