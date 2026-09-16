import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The manager reaches into pty-manager for the login shell's env, which pulls
// in node-pty — a native module built for Electron's ABI, not this runner's.
vi.mock('./pty-manager', () => ({ getLoginShellEnv: () => process.env }))

import { gitManager, parseCreatedFrom, parseCreatedAt, parseCreation } from './git-manager'

/**
 * The worktree reading of a checkout (PRDCT-2356), over real repositories:
 * a repo that is its own checkout reports none; a linked worktree reports the
 * main checkout it belongs to, the branch it was cut from, and the two-sided
 * count against it; the two worktree ranges list what each side changed.
 *
 * The base comes from the branch's reflog first, then from an upstream of
 * another name, then from the remote's default branch, and never from the
 * folder's name — each source has its fixture below.
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
/** A main checkout on `main`, with a bare origin. */
let repo: string
/** A worktree cut from the local `main`. */
let wtLocal: string
/** A worktree cut from `origin/main`. */
let wtRemote: string
/** A worktree whose branch has no reflog left, tracking `origin/main`. */
let wtNoReflog: string
/** A branch cut from a detached HEAD with no upstream: the remote's default branch is its base. */
let wtDetached: string
/** A detached checkout, no branch at all: no base, whatever the remote's HEAD. */
let wtPureDetached: string
/** Its two commits squash-merged into main: none of them in main, all of their diff is. */
let wtSquashed: string
/** Its commit merged into main with a merge commit. */
let wtMerged: string
/** Cut from a branch that was deleted afterwards: under its repo, no base. */
let wtGone: string
/** Squash-merged into `alt`, then that squash reverted on `alt`: not merged. */
let wtReverted: string
/** Squash-merged into `alt`, reverted, then the revert reverted: merged again. */
let wtReapplied: string

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'clave-git-worktree-')))
  const origin = path.join(root, 'origin.git')
  git(root, 'init', '-q', '--bare', '--initial-branch=main', origin)

  repo = path.join(root, 'app')
  git(root, 'clone', '-q', origin, repo)
  git(repo, 'checkout', '-q', '-b', 'main')
  commit(repo, 'README.md', 'seed')
  commit(repo, 'base.txt', 'base one')
  git(repo, 'push', '-q', '-u', 'origin', 'main')

  // Cut from the local branch: the reflog says `Created from main`.
  wtLocal = path.join(root, 'wt-local')
  git(repo, 'worktree', 'add', '-q', wtLocal, '-b', 'lane/local', 'main')
  commit(wtLocal, 'a.txt', 'lane a')
  commit(wtLocal, 'b.txt', 'lane b')
  commit(wtLocal, 'c.txt', 'lane c')

  // Cut from the remote ref: the reflog says `Created from origin/main`.
  wtRemote = path.join(root, 'wt-remote')
  git(repo, 'worktree', 'add', '-q', wtRemote, '-b', 'lane/remote', 'origin/main')

  // The reflog gone (a branch made elsewhere, or expired): the upstream of
  // another name is the next source.
  wtNoReflog = path.join(root, 'wt-noreflog')
  git(repo, 'worktree', 'add', '-q', wtNoReflog, '-b', 'lane/noreflog', 'main')
  git(wtNoReflog, 'branch', '-q', '--set-upstream-to=origin/main', 'lane/noreflog')
  unlinkSync(path.join(repo, '.git', 'logs', 'refs', 'heads', 'lane', 'noreflog'))

  // The clone of an empty bare origin carries no origin/HEAD symref; set it,
  // since it is the third source of a base and both detached fixtures below
  // turn on it.
  git(repo, 'remote', 'set-head', 'origin', 'main')

  // A branch cut from a detached position, no upstream: its reflog says
  // `Created from HEAD`, which names nothing, so the default branch answers.
  wtDetached = path.join(root, 'wt-detached')
  git(repo, 'worktree', 'add', '-q', '--detach', wtDetached, 'main')
  git(wtDetached, 'checkout', '-q', '-b', 'lane/detached')

  // A detached checkout with no branch at all, as a verifier's tree is.
  wtPureDetached = path.join(root, 'wt-pure-detached')
  git(repo, 'worktree', 'add', '-q', '--detach', wtPureDetached, 'main')

  // Then the base moves on: two commits on main the worktrees lack.
  commit(repo, 'base.txt', 'base two')
  commit(repo, 'base.txt', 'base three')
  git(repo, 'push', '-q', 'origin', 'main')

  // A lane squash-merged the way ours land: two commits on the branch, one
  // commit on main carrying their net diff, the branch itself untouched.
  wtSquashed = path.join(root, 'wt-squashed')
  git(repo, 'worktree', 'add', '-q', wtSquashed, '-b', 'lane/squashed', 'main')
  commit(wtSquashed, 's1.txt', 'squash one')
  commit(wtSquashed, 's1.txt', 'squash two')
  git(repo, 'merge', '-q', '--squash', 'lane/squashed')
  git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'Squash of lane/squashed')

  // A branch merged with a merge commit: its commit is an ancestor of main.
  wtMerged = path.join(root, 'wt-merged')
  git(repo, 'worktree', 'add', '-q', wtMerged, '-b', 'lane/merged', 'main')
  commit(wtMerged, 'm1.txt', 'merge one')
  git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'merge', '-q', '--no-ff', '--no-edit', 'lane/merged')

  // Cut from a branch that is deleted afterwards (review of PR #55, finding 16).
  git(repo, 'branch', 'tempbase', 'main')
  wtGone = path.join(root, 'wt-gone')
  git(repo, 'worktree', 'add', '-q', wtGone, '-b', 'lane/gone', 'tempbase')
  commit(wtGone, 'g.txt', 'gone one')
  git(repo, 'branch', '-q', '-D', 'tempbase')

  // On a base of its own, `alt`, so main's counts above stay what they are:
  // a squash reverted afterwards (finding 17), and one reverted then re-applied.
  git(repo, 'branch', 'alt', 'main')
  const altCommit = (msg: string): string =>
    git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', msg)
  const revertHead = (): string =>
    git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'revert', '--no-edit', 'HEAD')
  git(repo, 'checkout', '-q', 'alt')
  wtReverted = path.join(root, 'wt-reverted')
  git(repo, 'worktree', 'add', '-q', wtReverted, '-b', 'lane/reverted', 'alt')
  commit(wtReverted, 'v.txt', 'reverted one')
  git(repo, 'merge', '-q', '--squash', 'lane/reverted')
  altCommit('Squash of lane/reverted')
  revertHead()

  wtReapplied = path.join(root, 'wt-reapplied')
  git(repo, 'worktree', 'add', '-q', wtReapplied, '-b', 'lane/reapplied', 'alt')
  commit(wtReapplied, 'w.txt', 'reapplied one')
  git(repo, 'merge', '-q', '--squash', 'lane/reapplied')
  altCommit('Squash of lane/reapplied')
  revertHead()
  revertHead()
  git(repo, 'checkout', '-q', 'main')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('parseCreatedFrom', () => {
  it('reads the oldest entry, which is the last line', () => {
    const reflog = 'commit: lane b\ncommit: lane a\nbranch: Created from origin/dev\n'
    expect(parseCreatedFrom(reflog)).toBe('origin/dev')
  })
  it('names nothing for a branch cut from a detached HEAD', () => {
    expect(parseCreatedFrom('branch: Created from HEAD\n')).toBeNull()
  })
  it('names nothing when the oldest entry is not a creation', () => {
    expect(parseCreatedFrom('commit: something\n')).toBeNull()
    expect(parseCreatedFrom('')).toBeNull()
  })
})

describe('parseCreation', () => {
  it('reads the sha and the moment of the creation entry, the last line', () => {
    const reflog =
      'bbbbbbb\tlane/x@{1758024000}\tcommit: lane a\naaaaaaa\tlane/x@{1758020524}\tbranch: Created from origin/dev\n'
    expect(parseCreation(reflog)).toEqual({ sha: 'aaaaaaa', at: 1758020524000 })
  })
  it('names nothing when the oldest entry is not a creation', () => {
    expect(parseCreation('bbbbbbb\tlane/x@{1758024000}\tcommit: something\n')).toBeNull()
    expect(parseCreation('')).toBeNull()
  })
})

describe('parseCreatedAt', () => {
  it('reads the sha of the creation entry, the last line', () => {
    const reflog = 'bbbbbbb\tcommit: lane a\naaaaaaa\tbranch: Created from origin/dev\n'
    expect(parseCreatedAt(reflog)).toBe('aaaaaaa')
  })
  it('names nothing when the oldest entry is not a creation', () => {
    expect(parseCreatedAt('bbbbbbb\tcommit: something\n')).toBeNull()
    expect(parseCreatedAt('')).toBeNull()
  })
})

describe('getStatus on a main checkout', () => {
  it('carries no worktree reading', async () => {
    const status = await gitManager.getStatus(repo)
    expect(status.isRepo).toBe(true)
    expect(status.worktree).toBeUndefined()
  })
})

describe('getStatus on a worktree cut from the local branch', () => {
  it('names the main checkout, the base, and counts both sides', async () => {
    const status = await gitManager.getStatus(wtLocal)
    expect(status.worktree).toBeDefined()
    expect(realpathSync(status.worktree!.of)).toBe(repo)
    expect(status.worktree!.base).toBe('main')
    expect(status.worktree!.baseLabel).toBe('main')
    expect(status.worktree!.ahead).toBe(3)
    // Two base commits, the squash and the merge commit: main has moved on.
    expect(status.worktree!.behind).toBe(5)
    expect(status.worktree!.merged).toBe(false)
  })

  it('carries when the branch was created and its last commit', async () => {
    const status = await gitManager.getStatus(wtLocal)
    const created = status.worktree!.createdAt
    expect(created).not.toBeNull()
    // Epoch milliseconds, within the last hour: the fixture was cut just now.
    expect(Date.now() - created!).toBeLessThan(60 * 60 * 1000)
    expect(status.worktree!.lastCommit?.subject).toBe('lane c')
    expect(status.worktree!.lastCommit!.at).toBeGreaterThanOrEqual(created!)
  })

  it('the worktree range lists what the worktree added, the base range what the base gained', async () => {
    const added = await gitManager.getRangeFiles(wtLocal, 'worktree')
    expect(added.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(added.every((f) => f.status === 'A')).toBe(true)

    const gained = await gitManager.getRangeFiles(wtLocal, 'base')
    expect(gained.map((f) => f.path).sort()).toEqual(['base.txt', 'm1.txt', 's1.txt'])
    expect(gained.find((f) => f.path === 'base.txt')?.status).toBe('M')

    const diff = await gitManager.getRangeDiff(wtLocal, 'base', 'base.txt')
    expect(diff).toContain('+base three')
    expect(diff).not.toContain('lane a')
  })
})

describe('getStatus on a worktree cut from the remote ref', () => {
  it('keeps the remote ref as the base and drops the remote from the label', async () => {
    const status = await gitManager.getStatus(wtRemote)
    expect(status.worktree?.base).toBe('origin/main')
    expect(status.worktree?.baseLabel).toBe('main')
    expect(status.worktree?.ahead).toBe(0)
    expect(status.worktree?.behind).toBe(2)
  })
})

describe('getStatus on a worktree whose branch has no reflog', () => {
  it('falls back to the upstream of another name', async () => {
    const status = await gitManager.getStatus(wtNoReflog)
    expect(status.worktree?.base).toBe('origin/main')
    expect(status.worktree?.baseLabel).toBe('main')
    expect(status.worktree?.behind).toBe(2)
  })
})

describe('getStatus on a branch cut from a detached HEAD', () => {
  it('falls back to the remote’s default branch', async () => {
    const status = await gitManager.getStatus(wtDetached)
    expect(status.worktree?.base).toBe('origin/main')
    expect(status.worktree?.baseLabel).toBe('main')
    expect(status.worktree?.behind).toBe(2)
  })
})

describe('merged into the base', () => {
  it('a squash-merged worktree is merged, its commits still counted', async () => {
    const status = await gitManager.getStatus(wtSquashed)
    expect(status.worktree?.base).toBe('main')
    expect(status.worktree?.ahead).toBe(2)
    expect(status.worktree?.merged).toBe(true)
  })

  it('a worktree merged with a merge commit is merged, nothing ahead', async () => {
    const status = await gitManager.getStatus(wtMerged)
    expect(status.worktree?.ahead).toBe(0)
    expect(status.worktree?.merged).toBe(true)
  })

  it('a worktree with work the base does not carry is not', async () => {
    const status = await gitManager.getStatus(wtLocal)
    expect(status.worktree?.merged).toBe(false)
  })

  it('a fresh worktree with nothing done is not merged either', async () => {
    const status = await gitManager.getStatus(wtRemote)
    expect(status.worktree?.ahead).toBe(0)
    expect(status.worktree?.merged).toBe(false)
  })

  it('a squash reverted on the base is not merged; reverted then re-applied, it is', async () => {
    const reverted = await gitManager.getStatus(wtReverted)
    expect(reverted.worktree?.base).toBe('alt')
    expect(reverted.worktree?.ahead).toBe(1)
    expect(reverted.worktree?.merged).toBe(false)

    const reapplied = await gitManager.getStatus(wtReapplied)
    expect(reapplied.worktree?.base).toBe('alt')
    expect(reapplied.worktree?.merged).toBe(true)
  })

  it('reads nothing into the object store', async () => {
    const loose = (): number => {
      const out = git(repo, 'count-objects', '-v')
      return parseInt(/^count: (\d+)/m.exec(out)?.[1] ?? '0', 10)
    }
    const before = loose()
    await gitManager.getStatus(wtSquashed)
    await gitManager.getStatus(wtLocal)
    await gitManager.getStatus(wtReverted)
    expect(loose()).toBe(before)
  })
})

describe('getStatus on a worktree whose base branch was deleted', () => {
  it('still hangs under its repo, with no base rather than a guessed one', async () => {
    const status = await gitManager.getStatus(wtGone)
    expect(status.worktree).toBeDefined()
    expect(realpathSync(status.worktree!.of)).toBe(repo)
    expect(status.worktree!.base).toBeNull()
    expect(status.worktree!.ahead).toBe(0)
  })
})

describe('getStatus on a detached checkout', () => {
  it('still says which checkout it belongs to, with no base and no counts, whatever the remote’s HEAD', async () => {
    const status = await gitManager.getStatus(wtPureDetached)
    expect(status.worktree).toBeDefined()
    expect(realpathSync(status.worktree!.of)).toBe(repo)
    expect(status.worktree!.base).toBeNull()
    expect(status.worktree!.ahead).toBe(0)
    expect(status.worktree!.behind).toBe(0)
    // No branch, so no creation entry: the directory's birth time stands in.
    expect(status.worktree!.createdAt).not.toBeNull()
    expect(Date.now() - status.worktree!.createdAt!).toBeLessThan(60 * 60 * 1000)
  })

  it('and its worktree ranges are empty rather than guessed', async () => {
    expect(await gitManager.getRangeFiles(wtPureDetached, 'worktree')).toEqual([])
    expect(await gitManager.getRangeFiles(wtPureDetached, 'base')).toEqual([])
  })
})
