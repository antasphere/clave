import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// The manager reaches into pty-manager for the login shell's env, which pulls
// in node-pty — a native module built for Electron's ABI, not this runner's.
// The env it answers is the test's: PATH names a folder holding the `claude`
// of the case (one that writes, one that refuses, none at all).
const mocks = vi.hoisted(() => ({ env: { ...process.env } as Record<string, string> }))
vi.mock('../pty-manager', () => ({ getLoginShellEnv: () => mocks.env }))

import { describeClaudeFailure, serverGitPort, type ServerGitPort } from './git-port'
import type { GitEvent } from '@clave/server'

/**
 * The daemon's git port over real repositories (wave wcs1023, lane C, #242):
 * the app's own implementation answers for a checkout on this disk, a change
 * on the disk is told as `git.repos_changed`, a batch reports its progress,
 * and a commit message is written by THIS machine's `claude` — or the error
 * names the server's missing Claude login in one sentence.
 */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })

// /private/tmp, not /tmp: git resolves the symlink, and a repo root that
// disagrees with the asked path makes every reading look nested.
const SCRATCH = '/private/tmp/clave-wcs-c-unit'
let root: string
let repo: string
let bins: { writing: string; refusing: string; none: string }
let port: ServerGitPort
const events: GitEvent[] = []

const stub = (dir: string, body: string): void => {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'claude')
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}
const withClaude = (dir: string): void => {
  mocks.env = { ...process.env, PATH: dir }
}
const until = async (check: () => boolean, ms = 4000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return check()
}

beforeAll(() => {
  mkdirSync(SCRATCH, { recursive: true })
  root = mkdtempSync(path.join(SCRATCH, 'port-'))
  repo = path.join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(path.join(repo, 'README.md'), '# repo\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  bins = {
    writing: path.join(root, 'bin-writing'),
    refusing: path.join(root, 'bin-refusing'),
    none: path.join(root, 'bin-none')
  }
  stub(bins.writing, '/bin/cat >/dev/null; echo "feat: written by the server"')
  stub(bins.refusing, '/bin/cat >/dev/null; echo "Not logged in · Please run /login" >&2; exit 1')
  mkdirSync(bins.none, { recursive: true })
  port = serverGitPort({ debounceMs: 50, maxWaitMs: 200, log: () => {} })
  port.subscribe((event) => events.push(event))
})
afterAll(() => {
  port.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('the daemon’s git port over a real checkout', () => {
  it('reads, stages and commits on this disk, and the log says so', async () => {
    writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    const before = await port.status(repo)
    expect(before.isRepo).toBe(true)
    expect(before.repoRoot).toBe(repo)
    expect(before.files).toEqual([{ path: 'a.txt', status: 'untracked', staged: false }])
    await port.stage(repo, ['a.txt'])
    expect((await port.status(repo)).files).toEqual([
      { path: 'a.txt', status: 'staged', staged: true }
    ])
    const commit = await port.commit(repo, 'feat: a')
    expect(commit.branch).toBe('main')
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('feat: a')
    expect((await port.log(repo, 1))[0]).toMatchObject({ message: 'feat: a', hash: commit.hash })
    expect((await port.statusBatch([repo]))[0]).toMatchObject({ path: repo })
  })

  it('finds the repository under its parent folder', async () => {
    const found = await port.discover(root, true)
    expect(found.repos.map((r) => r.path)).toEqual([repo])
  })

  it('tells a change on the disk as git.repos_changed for the watched repository', async () => {
    expect(await port.watch('mac-1:git-status-1', [repo])).toEqual([repo])
    events.length = 0
    writeFileSync(path.join(repo, 'b.txt'), 'two\n')
    expect(
      await until(() =>
        events.some((e) => e._tag === 'git.repos_changed' && e.repos.includes(repo))
      ),
      `expected a repos_changed event, got ${JSON.stringify(events)}`
    ).toBe(true)
    await port.unwatch('mac-1:git-status-1')
  })

  it('writes the commit message with this machine’s claude', async () => {
    withClaude(bins.writing)
    writeFileSync(path.join(repo, 'c.txt'), 'three\n')
    await port.stage(repo, ['c.txt'])
    expect(await port.generateCommitMessage(repo)).toBe('feat: written by the server')
    await port.commit(repo, 'feat: c')
  })

  it('names the server’s missing Claude login in one sentence', async () => {
    writeFileSync(path.join(repo, 'd.txt'), 'four\n')
    await port.stage(repo, ['d.txt'])
    withClaude(bins.refusing)
    await expect(port.generateCommitMessage(repo)).rejects.toThrow(
      'This server\'s Claude is not signed in: run "claude login" on the server to generate commit messages.'
    )
    withClaude(bins.none)
    await expect(port.generateCommitMessage(repo)).rejects.toThrow(
      'This server has no "claude" command: install Claude Code on the server and sign in to generate commit messages.'
    )
    await port.commit(repo, 'feat: d')
  })

  it('reports a Magic sync’s progress and carries the Claude sentence in the repo’s result', async () => {
    withClaude(bins.refusing)
    writeFileSync(path.join(repo, 'e.txt'), 'five\n')
    events.length = 0
    const results = await port.magicSync([repo], 'mac-test:1')
    expect(results).toEqual([
      {
        repoPath: repo,
        actions: ['staged'],
        error:
          'This server\'s Claude is not signed in: run "claude login" on the server to generate commit messages.'
      }
    ])
    const progress = events.filter((e) => e._tag === 'git.batch_progress')
    expect(progress.map((e) => (e._tag === 'git.batch_progress' ? e.phase : ''))).toContain(
      'generating'
    )
    expect(progress.at(-1)).toMatchObject({
      op: 'sync',
      done: 1,
      total: 1,
      repoPath: repo,
      batchId: 'mac-test:1'
    })
    git(repo, 'reset', '-q')
  })
})

describe('describeClaudeFailure', () => {
  it('maps the two ways a server has no Claude login, and leaves the rest as said', () => {
    expect(describeClaudeFailure('spawn claude ENOENT')).toMatch(/no "claude" command/)
    expect(
      describeClaudeFailure('Command failed: claude -p — Invalid API key · Please run /login')
    ).toMatch(/not signed in/)
    expect(describeClaudeFailure('Command failed: claude -p — Not logged in')).toMatch(
      /not signed in/
    )
    expect(describeClaudeFailure('Empty response from Claude')).toBe('Empty response from Claude')
    expect(describeClaudeFailure('No staged changes — stage files first')).toBe(
      'No staged changes — stage files first'
    )
  })
})
