import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

vi.mock('./pty-manager', () => ({ getLoginShellEnv: () => process.env }))

import { gitManager } from './git-manager'

/**
 * What the status read keeps between reads (PRDCT-3775), over real repos: a
 * linked worktree's reading is reused only while nothing it depends on moved,
 * a status read never rewrites the index, and the background fetch skips a
 * repo fetched a moment ago.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
const commit = (cwd: string, file: string, message: string): void => {
  writeFileSync(path.join(cwd, file), `${message}\n`)
  git(cwd, 'add', file)
  git(cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', message)
}

let root: string
let origin: string
let repo: string
let wt: string

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'clave-git-cache-')))
  origin = path.join(root, 'origin.git')
  git(root, 'init', '-q', '--bare', '--initial-branch=main', origin)
  repo = path.join(root, 'app')
  git(root, 'clone', '-q', origin, repo)
  git(repo, 'checkout', '-q', '-b', 'main')
  commit(repo, 'README.md', 'seed')
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  wt = path.join(root, 'wt-lane')
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'lane/x', 'main')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the cached worktree reading', () => {
  it('follows a commit in the worktree', async () => {
    const before = await gitManager.getStatus(wt)
    expect(before.worktree?.base).toBe('main')
    expect(before.worktree?.ahead).toBe(0)
    commit(wt, 'a.txt', 'lane a')
    const after = await gitManager.getStatus(wt)
    expect(after.worktree?.ahead).toBe(1)
    expect(after.worktree?.lastCommit?.subject).toBe('lane a')
  })

  it('follows its base moving on', async () => {
    const before = await gitManager.getStatus(wt)
    const behind = before.worktree?.behind ?? -1
    commit(repo, 'base.txt', 'base moves')
    const after = await gitManager.getStatus(wt)
    expect(after.worktree?.behind).toBe(behind + 1)
  })

  it('is reused while nothing moved', async () => {
    const first = await gitManager.getStatus(wt)
    const second = await gitManager.getStatus(wt)
    // The same object: the reading was not computed again.
    expect(second.worktree).toBe(first.worktree)
  })

  it('reports a plain checkout as no worktree', async () => {
    const status = await gitManager.getStatus(repo)
    expect(status.isRepo).toBe(true)
    expect(status.worktree).toBeUndefined()
    expect(status.repoRoot).toBe(repo)
  })

  it('answers not-a-repo for a plain folder', async () => {
    const status = await gitManager.getStatus(root)
    expect(status.isRepo).toBe(false)
  })
})

describe('the status read', () => {
  it('never rewrites the index', async () => {
    const file = path.join(repo, 'README.md')
    // A file whose stat no longer matches the index: a plain `git status`
    // refreshes the index on disk to record the new stat.
    const past = new Date(Date.now() - 60_000)
    utimesSync(file, past, past)
    const index = path.join(repo, '.git', 'index')
    const before = statSync(index).mtimeMs
    await gitManager.getStatus(repo)
    expect(statSync(index).mtimeMs).toBe(before)
  })
})

describe('the background fetch', () => {
  it('skips a repo fetched a moment ago, and the Refresh fetch does not', async () => {
    const other = path.join(root, 'other')
    git(root, 'clone', '-q', origin, other)
    await gitManager.fetch(repo)
    const seen = git(repo, 'rev-parse', 'origin/main').trim()

    commit(other, 'remote.txt', 'remote moves')
    git(other, 'push', '-q', 'origin', 'HEAD:main')
    const pushed = git(other, 'rev-parse', 'HEAD').trim()

    await gitManager.fetch(repo)
    expect(git(repo, 'rev-parse', 'origin/main').trim()).toBe(seen)

    await gitManager.fetchOrThrow(repo)
    expect(git(repo, 'rev-parse', 'origin/main').trim()).toBe(pushed)
  })
})

describe('the app-wide limit, as the manager applies it', () => {
  it('runs at most four status reads at once, whatever the batch', async () => {
    let running = 0
    let peak = 0
    const spy = vi.spyOn(gitManager, 'readStatus').mockImplementation(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return {
        isRepo: false,
        branch: '',
        ahead: 0,
        behind: 0,
        hasUpstream: false,
        files: [],
        repoRoot: ''
      }
    })
    try {
      const paths = Array.from({ length: 40 }, (_, i) => `/nowhere/r${i}`)
      // Two stacked batches, as two windows or two late rounds would send.
      await Promise.all([gitManager.getStatusBatch(paths), gitManager.getStatusBatch(paths)])
      expect(peak).toBe(4)
    } finally {
      spy.mockRestore()
    }
  })

  it('runs at most two background fetches at once', async () => {
    let running = 0
    let peak = 0
    const spy = vi.spyOn(gitManager, 'fetchOrThrow').mockImplementation(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
    })
    try {
      await gitManager.fetchBatch(Array.from({ length: 12 }, (_, i) => `/nowhere/f${i}`))
      expect(peak).toBe(2)
      expect(spy).toHaveBeenCalledTimes(12)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('the cached worktree reading, other shapes', () => {
  it('follows a detached worktree moved to another commit', async () => {
    const detached = path.join(root, 'wt-detached')
    git(repo, 'worktree', 'add', '-q', '--detach', detached, 'main')
    const first = await gitManager.getStatus(detached)
    git(detached, 'checkout', '-q', '--detach', 'main~1')
    const second = await gitManager.getStatus(detached)
    expect(second.worktree?.lastCommit?.subject).not.toBe(first.worktree?.lastCommit?.subject)
  })

  it('follows a base spelled as an expression', async () => {
    const expr = path.join(root, 'wt-expr')
    git(repo, 'worktree', 'add', '-q', expr, '-b', 'lane/expr', 'main~1')
    const before = await gitManager.getStatus(expr)
    expect(before.worktree?.base).toBe('main~1')
    commit(repo, 'expr.txt', 'base moves under the expression')
    const after = await gitManager.getStatus(expr)
    expect(after.worktree?.behind).toBe((before.worktree?.behind ?? 0) + 1)
  })

  it('does not keep a failed reading as the answer', async () => {
    const spy = vi
      .spyOn(gitManager as unknown as { readWorktree: () => Promise<unknown> }, 'readWorktree')
      .mockRejectedValueOnce(new Error('transient'))
    const failing = path.join(root, 'wt-flaky')
    git(repo, 'worktree', 'add', '-q', failing, '-b', 'lane/flaky', 'main')
    const first = await gitManager.getStatus(failing)
    expect(first.worktree).toBeUndefined()
    spy.mockRestore()
    const second = await gitManager.getStatus(failing)
    expect(second.worktree?.base).toBe('main')
  })
})

describe('what a folder is to git', () => {
  it('is asked again once its not-a-repo answer has expired', async () => {
    const folder = path.join(root, 'later')
    execFileSync('mkdir', [folder])
    expect((await gitManager.getStatus(folder)).isRepo).toBe(false)
    git(folder, 'init', '-q')
    // Within its thirty seconds the answer stands...
    expect((await gitManager.getStatus(folder)).isRepo).toBe(false)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31_000)
    try {
      expect((await gitManager.getStatus(folder)).isRepo).toBe(true)
    } finally {
      clock.mockRestore()
    }
  })
})

describe('the cached worktree reading, round 2', () => {
  it('does not keep a first reading a commit landed during', async () => {
    const fresh = path.join(root, 'wt-first')
    git(repo, 'worktree', 'add', '-q', fresh, '-b', 'lane/first', 'main')
    const target = gitManager as unknown as {
      readWorktree: (...args: unknown[]) => Promise<unknown>
    }
    const original = target.readWorktree.bind(gitManager)
    const spy = vi.spyOn(target, 'readWorktree').mockImplementationOnce(async (...args) => {
      const reading = await original(...args)
      // The commit lands after the reading computed, before it is stored.
      commit(fresh, 'during.txt', 'committed during the first reading')
      return reading
    })
    try {
      await gitManager.getStatus(fresh)
    } finally {
      spy.mockRestore()
    }
    const next = await gitManager.getStatus(fresh)
    expect(next.worktree?.ahead).toBe(1)
    expect(next.worktree?.lastCommit?.subject).toBe('committed during the first reading')
  })

  it('follows a base that is a tag', async () => {
    git(repo, 'tag', 'v-base', 'main')
    const tagged = path.join(root, 'wt-tag')
    git(repo, 'worktree', 'add', '-q', tagged, '-b', 'lane/tag', 'v-base')
    const before = await gitManager.getStatus(tagged)
    expect(before.worktree?.base).toBe('v-base')
    commit(repo, 'tag.txt', 'the tag moves on')
    git(repo, 'tag', '-f', 'v-base', 'main')
    const after = await gitManager.getStatus(tagged)
    expect(after.worktree?.behind).toBe((before.worktree?.behind ?? 0) + 1)
  })

  it('follows a base spelled as a full ref name', async () => {
    const full = path.join(root, 'wt-full')
    git(repo, 'worktree', 'add', '-q', full, '-b', 'lane/full', 'refs/heads/main')
    const before = await gitManager.getStatus(full)
    commit(repo, 'full.txt', 'base moves under its full name')
    const after = await gitManager.getStatus(full)
    expect(after.worktree?.behind).toBe((before.worktree?.behind ?? 0) + 1)
  })

  it('does not keep a reading that failed inside', async () => {
    const inner = path.join(root, 'wt-inner')
    git(repo, 'worktree', 'add', '-q', inner, '-b', 'lane/inner', 'main')
    const spy = vi
      .spyOn(gitManager, 'resolveWorktreeBase')
      .mockRejectedValueOnce(new Error('transient inside the reading'))
    const first = await gitManager.getStatus(inner)
    expect(first.worktree).toBeUndefined()
    spy.mockRestore()
    const second = await gitManager.getStatus(inner)
    expect(second.worktree?.base).toBe('main')
  })
})

describe('the cached worktree reading, round 3', () => {
  const target = gitManager as unknown as {
    readWorktree: (...args: unknown[]) => Promise<unknown>
  }

  it('does not keep a first reading its base moved during', async () => {
    const wt3 = path.join(root, 'wt-base-moves-first')
    git(repo, 'worktree', 'add', '-q', wt3, '-b', 'lane/base-first', 'main')
    const original = target.readWorktree.bind(gitManager)
    const spy = vi.spyOn(target, 'readWorktree').mockImplementationOnce(async (...args) => {
      const reading = await original(...args)
      commit(repo, 'first-base.txt', 'base moves during the first reading')
      return reading
    })
    try {
      await gitManager.getStatus(wt3)
    } finally {
      spy.mockRestore()
    }
    expect((await gitManager.getStatus(wt3)).worktree?.behind).toBe(1)
  })

  it('does not keep a steady reading its base moved during', async () => {
    const wt4 = path.join(root, 'wt-base-moves-steady')
    git(repo, 'worktree', 'add', '-q', wt4, '-b', 'lane/base-steady', 'main')
    await gitManager.getStatus(wt4)
    // A second read with the base known, so the cache holds a verified reading.
    commit(wt4, 'own.txt', 'own work')
    await gitManager.getStatus(wt4)
    const original = target.readWorktree.bind(gitManager)
    commit(wt4, 'own2.txt', 'more own work')
    const spy = vi.spyOn(target, 'readWorktree').mockImplementationOnce(async (...args) => {
      const reading = await original(...args)
      commit(repo, 'steady-base.txt', 'base moves during a steady reading')
      return reading
    })
    try {
      await gitManager.getStatus(wt4)
    } finally {
      spy.mockRestore()
    }
    expect((await gitManager.getStatus(wt4)).worktree?.behind).toBe(1)
  })

  it('follows a branch whose name carries a hash sign', async () => {
    const hashed = path.join(root, 'wt-hash')
    git(repo, 'worktree', 'add', '-q', hashed, '-b', 'lane/fix#12', 'main')
    await gitManager.getStatus(hashed)
    await gitManager.getStatus(hashed)
    commit(hashed, 'hash.txt', 'on a hashed branch')
    expect((await gitManager.getStatus(hashed)).worktree?.ahead).toBe(1)
  })

  it('follows an upstream change that chooses a new base', async () => {
    const up = path.join(root, 'wt-upstream')
    git(repo, 'branch', 'side', 'main')
    // A branch with no reflog creation entry and no upstream: no base yet.
    git(repo, 'worktree', 'add', '-q', '--detach', up, 'main')
    git(up, 'checkout', '-q', '-b', 'lane/upstream')
    const logFile = path.join(repo, '.git', 'logs', 'refs', 'heads', 'lane', 'upstream')
    rmSync(logFile, { force: true })
    git(repo, 'remote', 'set-head', 'origin', '--delete')
    await gitManager.getStatus(up)
    await gitManager.getStatus(up)
    git(up, 'branch', '-q', '--set-upstream-to=side', 'lane/upstream')
    expect((await gitManager.getStatus(up)).worktree?.base).toBe('side')
  })
})
