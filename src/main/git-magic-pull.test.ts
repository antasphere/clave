import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The manager reaches into pty-manager for the login shell's env, which pulls
// in node-pty — a native module built for Electron's ABI, not this runner's.
// Only `generateCommitMessage` needs it, and nothing here calls that.
vi.mock('./pty-manager', () => ({ getLoginShellEnv: () => process.env }))

import { gitManager } from './git-manager'
import type { GitBatchProgress } from '../shared/git-batch'

/**
 * The split between pulling and going to look, over real repositories.
 *
 * `magicPull` pulls the repos that are behind and NOTHING else — no fetch, no
 * sweep. `refreshRemotes` is the half that talks to every remote. The division
 * is the feature: Pull all used to fetch N repos serially before pulling any,
 * which on a folder of ninety is a minute of network for a click the user made
 * because they could already see three arrows.
 *
 * So the assertions are as much about what does NOT happen as what does: a repo
 * that is behind on the server but whose refs do not know it must come back
 * untouched from a pull, and must be found by a refresh.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })

let root: string
/** Behind, and its refs know it — the badged case. */
let behindRepo: string
/** Behind on the server, but nothing has fetched: no badge, no pull. */
let staleRepo: string
/** Nothing to bring. */
let cleanRepo: string
/** Its remote does not exist. */
let brokenRepo: string
let originHead = ''

function makeOriginWithClone(name: string): { origin: string; clone: string } {
  const origin = path.join(root, `${name}.git`)
  git(root, 'init', '--bare', '--initial-branch=main', origin)

  const seed = path.join(root, `${name}-seed`)
  git(root, 'clone', origin, seed)
  git(seed, 'config', 'user.email', 'test@example.com')
  git(seed, 'config', 'user.name', 'Test')
  writeFileSync(path.join(seed, 'README.md'), '# seed\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-m', 'seed')
  git(seed, 'push', 'origin', 'main')

  const clone = path.join(root, name)
  git(root, 'clone', origin, clone)
  return { origin, clone }
}

/** Put one new commit on a repo's origin, through a throwaway clone. */
function commitToOrigin(origin: string, name: string): string {
  const work = path.join(root, `${name}-push-${Date.now()}`)
  git(root, 'clone', origin, work)
  git(work, 'config', 'user.email', 'test@example.com')
  git(work, 'config', 'user.name', 'Test')
  // Unique content per call: a second commit of the same bytes is not a commit.
  writeFileSync(path.join(work, 'incoming.txt'), `from the remote: ${name} ${Date.now()}\n`)
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'incoming')
  git(work, 'push', 'origin', 'main')
  return git(work, 'rev-parse', 'HEAD').trim()
}

/** What this repo's remote-tracking ref currently points at — the number the
 *  panel's ↓ badge is computed from, and the thing only a fetch can move. */
const trackedRef = (repo: string): string => git(repo, 'rev-parse', 'origin/main').trim()

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'clave-magic-pull-'))

  const behind = makeOriginWithClone('behind')
  behindRepo = behind.clone
  originHead = commitToOrigin(behind.origin, 'behind')
  git(behindRepo, 'fetch', 'origin')

  const stale = makeOriginWithClone('stale')
  staleRepo = stale.clone
  commitToOrigin(stale.origin, 'stale')
  // Deliberately NOT fetched: `git status` here says "up to date".

  cleanRepo = makeOriginWithClone('clean').clone

  brokenRepo = makeOriginWithClone('broken').clone
  git(brokenRepo, 'remote', 'set-url', 'origin', path.join(root, 'does-not-exist.git'))
}, 120_000)

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('magicPull', () => {
  it('pulls the repos that are behind, and counts every repo it was given', async () => {
    const events: GitBatchProgress[] = []
    const repos = [behindRepo, cleanRepo]

    const results = await gitManager.magicPull(repos, (p) => events.push(p))
    const byPath = new Map(results.map((r) => [r.repoPath, r]))

    expect(byPath.get(behindRepo)).toMatchObject({ pulled: true, error: null })
    expect(git(behindRepo, 'rev-parse', 'HEAD').trim()).toBe(originHead)
    expect(byPath.get(cleanRepo)).toMatchObject({ pulled: false, error: null })
    expect(results.map((r) => r.repoPath)).toEqual(repos)

    // The counter: one step per repo, monotonic, landing exactly on total.
    expect(new Set(events.map((e) => e.total))).toEqual(new Set([repos.length]))
    expect(events.every((e) => e.op === 'pull')).toBe(true)
    expect(events.every((e) => e.repoName.length > 0)).toBe(true)
    let last = 0
    for (const e of events) {
      expect(e.done).toBeGreaterThanOrEqual(last)
      expect(e.done - last).toBeLessThanOrEqual(1)
      last = e.done
    }
    expect(last).toBe(repos.length)
  }, 120_000)

  it('never goes to a remote to look for work: no fetch, ever', async () => {
    const before = trackedRef(staleRepo)
    const events: GitBatchProgress[] = []

    const results = await gitManager.magicPull([staleRepo], (p) => events.push(p))

    // The commit IS on the server. Pull all leaves it there — its job is the
    // badges, and no badge means no work.
    expect(results[0]).toMatchObject({ pulled: false, error: null })
    expect(trackedRef(staleRepo)).toBe(before)
    expect(git(staleRepo, 'log', '--oneline')).not.toContain('incoming')
    // And it says so without ever entering the fetch phase.
    expect(events.some((e) => e.phase === 'fetching')).toBe(false)
  }, 120_000)

  it('pulls a badged repo whose remote is unreachable: the commits are already on disk', async () => {
    // Behind by its own refs, then its remote is taken away underneath it —
    // the shape of a GitHub host that hangs, a revoked access, a renamed
    // origin. The badge's commits were fetched already, so none of that may
    // stop the pull (PRDCT-3372: a pull that went back to the network failed
    // whenever the network did, and the arrow stayed).
    const gone = makeOriginWithClone('gone')
    const head = commitToOrigin(gone.origin, 'gone')
    git(gone.clone, 'fetch', 'origin')
    expect((await gitManager.getStatus(gone.clone)).behind).toBeGreaterThan(0)
    git(gone.clone, 'remote', 'set-url', 'origin', path.join(root, 'does-not-exist.git'))

    const results = await gitManager.magicPull([gone.clone, cleanRepo])
    const byPath = new Map(results.map((r) => [r.repoPath, r]))
    expect(byPath.get(gone.clone)).toMatchObject({ pulled: true, error: null })
    expect(git(gone.clone, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect((await gitManager.getStatus(gone.clone)).behind).toBe(0)
    expect(byPath.get(cleanRepo)).toMatchObject({ pulled: false, error: null })
  }, 120_000)

  it('rebases local commits onto the fetched upstream when it cannot fast-forward', async () => {
    const div = makeOriginWithClone('diverged')
    const upstream = commitToOrigin(div.origin, 'diverged')
    git(div.clone, 'fetch', 'origin')
    git(div.clone, 'config', 'user.email', 'test@example.com')
    git(div.clone, 'config', 'user.name', 'Test')
    writeFileSync(path.join(div.clone, 'local.txt'), 'mine\n')
    git(div.clone, 'add', '.')
    git(div.clone, 'commit', '-m', 'local work')
    git(div.clone, 'remote', 'set-url', 'origin', path.join(root, 'does-not-exist.git'))

    const [result] = await gitManager.magicPull([div.clone])
    expect(result).toMatchObject({ pulled: true, error: null })
    // The local commit now sits on top of the upstream one.
    expect(git(div.clone, 'rev-parse', 'HEAD~1').trim()).toBe(upstream)
    expect(git(div.clone, 'log', '-1', '--format=%s').trim()).toBe('local work')
    const status = await gitManager.getStatus(div.clone)
    expect(status).toMatchObject({ behind: 0, ahead: 1 })
  }, 120_000)

  it('carries uncommitted changes across the integration', async () => {
    const dirty = makeOriginWithClone('dirty')
    const upstream = commitToOrigin(dirty.origin, 'dirty')
    git(dirty.clone, 'fetch', 'origin')
    // The incoming commit writes incoming.txt; the local edit is to README.md.
    writeFileSync(path.join(dirty.clone, 'README.md'), '# edited, not committed\n')

    const [result] = await gitManager.magicPull([dirty.clone])
    expect(result).toMatchObject({ pulled: true, error: null })
    expect(git(dirty.clone, 'rev-parse', 'HEAD').trim()).toBe(upstream)
    expect(git(dirty.clone, 'status', '--porcelain')).toContain('README.md')
  }, 120_000)

  it('fails a repo it cannot integrate with the reason, and leaves it as it was', async () => {
    const clash = makeOriginWithClone('clash')
    commitToOrigin(clash.origin, 'clash') // writes incoming.txt upstream
    git(clash.clone, 'fetch', 'origin')
    git(clash.clone, 'config', 'user.email', 'test@example.com')
    git(clash.clone, 'config', 'user.name', 'Test')
    writeFileSync(path.join(clash.clone, 'incoming.txt'), 'a different local line\n')
    git(clash.clone, 'add', '.')
    git(clash.clone, 'commit', '-m', 'local clash')
    const before = git(clash.clone, 'rev-parse', 'HEAD').trim()

    const results = await gitManager.magicPull([clash.clone, behindRepo])
    const byPath = new Map(results.map((r) => [r.repoPath, r]))
    expect(byPath.get(clash.clone)?.pulled).toBe(false)
    expect(byPath.get(clash.clone)?.error).toMatch(/conflict|could not apply/i)
    // Aborted: same head, no rebase left half-done, a clean tree.
    expect(git(clash.clone, 'rev-parse', 'HEAD').trim()).toBe(before)
    expect(git(clash.clone, 'status', '--porcelain').trim()).toBe('')
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      const p = path.resolve(clash.clone, git(clash.clone, 'rev-parse', '--git-path', dir).trim())
      expect(existsSync(p)).toBe(false)
    }
  }, 120_000)

  it('names a repo whose uncommitted changes clash with what came in, rather than calling it pulled', async () => {
    // Verifier round 1, finding 1: `rebase --autostash` exits 0 when only
    // putting the stashed changes back conflicts.
    const auto = makeOriginWithClone('autostash')
    const work = path.join(root, `autostash-up-${Date.now()}`)
    git(root, 'clone', auto.origin, work)
    git(work, 'config', 'user.email', 'test@example.com')
    git(work, 'config', 'user.name', 'Test')
    writeFileSync(path.join(work, 'README.md'), '# from upstream\n')
    git(work, 'commit', '-am', 'upstream edit')
    git(work, 'push', 'origin', 'main')
    git(auto.clone, 'fetch', 'origin')
    git(auto.clone, 'config', 'user.email', 'test@example.com')
    git(auto.clone, 'config', 'user.name', 'Test')
    // Diverged, so the fast-forward is refused and the rebase runs...
    writeFileSync(path.join(auto.clone, 'local.txt'), 'mine\n')
    git(auto.clone, 'add', 'local.txt')
    git(auto.clone, 'commit', '-m', 'local work')
    // ...with an uncommitted edit to the very lines upstream changed.
    writeFileSync(path.join(auto.clone, 'README.md'), '# mine, uncommitted\n')

    const [result] = await gitManager.magicPull([auto.clone])
    expect(result.pulled).toBe(false)
    expect(result.error).toMatch(/^CONFLICT: .*README\.md/)
    expect(result.error).toMatch(/stash/)
  }, 120_000)

  it('leaves a rebase the user has in progress alone', async () => {
    // Verifier round 1, finding 3: the cleanup abort used to cancel it.
    const mid = makeOriginWithClone('midrebase')
    commitToOrigin(mid.origin, 'midrebase') // writes incoming.txt upstream
    git(mid.clone, 'fetch', 'origin')
    git(mid.clone, 'config', 'user.email', 'test@example.com')
    git(mid.clone, 'config', 'user.name', 'Test')
    writeFileSync(path.join(mid.clone, 'incoming.txt'), 'local clash\n')
    git(mid.clone, 'add', '.')
    git(mid.clone, 'commit', '-m', 'local clash')
    try {
      git(mid.clone, 'rebase', 'origin/main')
    } catch {
      /* stops on the conflict, which is the point */
    }
    const marker = path.resolve(
      mid.clone,
      git(mid.clone, 'rev-parse', '--git-path', 'rebase-merge').trim()
    )
    expect(existsSync(marker)).toBe(true)

    await expect(gitManager.integrateUpstream(mid.clone)).rejects.toThrow(
      /rebase is already in progress/
    )
    expect(existsSync(marker)).toBe(true)
  }, 120_000)

  it('skips a repo nothing has fetched, rather than failing it', async () => {
    // `brokenRepo` has an unreachable remote too, but its refs say it is level
    // — so there is nothing to pull, and "no work" is the honest answer, not an
    // error the user has to read.
    const results = await gitManager.magicPull([brokenRepo])
    expect(results[0]).toMatchObject({ pulled: false, error: null })
  }, 120_000)

  it('dispatches its pulls together rather than one repo at a time', async () => {
    // Two repos genuinely behind and aware of it.
    const a = makeOriginWithClone('par-a')
    const b = makeOriginWithClone('par-b')
    commitToOrigin(a.origin, 'par-a')
    commitToOrigin(b.origin, 'par-b')
    git(a.clone, 'fetch', 'origin')
    git(b.clone, 'fetch', 'origin')

    const events: GitBatchProgress[] = []
    await gitManager.magicPull([a.clone, b.clone], (p) => events.push(p))

    const firstCompletion = events.findIndex((e, i) => i > 0 && e.done > events[i - 1].done)
    const pullStarts = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.phase === 'pulling' && e.done === 0)

    // Serialised, the second repo could not start until the first had finished,
    // so a completion would sit between the two starts.
    expect(pullStarts.length).toBe(2)
    expect(pullStarts.every(({ i }) => firstCompletion === -1 || i < firstCompletion)).toBe(true)
  }, 120_000)
})

describe('refreshRemotes', () => {
  it('is what makes a stale repo visible as behind', async () => {
    const before = trackedRef(staleRepo)
    const events: GitBatchProgress[] = []

    const results = await gitManager.refreshRemotes([staleRepo, cleanRepo], (p) => events.push(p))

    expect(results.every((r) => r.error === null)).toBe(true)
    expect(trackedRef(staleRepo)).not.toBe(before)

    // And now — only now — Pull all has something to do with it.
    const status = await gitManager.getStatus(staleRepo)
    expect(status.behind).toBeGreaterThan(0)
    const pulled = await gitManager.magicPull([staleRepo])
    expect(pulled[0]).toMatchObject({ pulled: true, error: null })
    expect(git(staleRepo, 'log', '--oneline')).toContain('incoming')

    // It reports as its own op, so the bar can say which thing is running.
    expect(events.every((e) => e.op === 'fetch')).toBe(true)
    expect(events[events.length - 1].done).toBe(2)
  }, 120_000)

  it('reports an unreachable remote instead of swallowing it', async () => {
    const results = await gitManager.refreshRemotes([brokenRepo, cleanRepo])
    const byPath = new Map(results.map((r) => [r.repoPath, r]))
    expect(byPath.get(brokenRepo)?.error).toBeTruthy()
    expect(byPath.get(cleanRepo)?.error).toBeNull()
  }, 120_000)

  it('sweeps in parallel, not one remote after another', async () => {
    const events: GitBatchProgress[] = []
    await gitManager.refreshRemotes([cleanRepo, staleRepo, behindRepo], (p) => events.push(p))

    const firstCompletion = events.findIndex((e, i) => i > 0 && e.done > events[i - 1].done)
    const starts = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.phase === 'fetching' && e.done === 0)
    expect(starts.length).toBeGreaterThanOrEqual(3)
    expect(starts.every(({ i }) => firstCompletion === -1 || i < firstCompletion)).toBe(true)
  }, 120_000)
})
