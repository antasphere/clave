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
