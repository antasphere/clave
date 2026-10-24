import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type {
  GitDiscardFile,
  GitEvent,
  GitOperations,
  GitPullStrategy,
  GitRangeDirection,
  GitStatusResult
} from '@clave/contract/git'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer } from '../test-support'
import type { GitService } from './port'
import type { Unsubscribe } from '../sessions/port'

/**
 * The git domain (wave wcs1023, lane C, #242) through the HTTP API and the
 * push channel over a fake port: each call reaches the port with what it was
 * sent (a GET's flags and numbers decoded), git's refusal is the declared
 * `GitOperationFailed` with git's sentence, a server without the port answers
 * `CapabilityUnavailable`, and the port's news reaches a client as a server
 * event.
 */
const aStatus = (repoRoot: string): GitStatusResult => ({
  isRepo: true,
  branch: 'main',
  ahead: 0,
  behind: 0,
  hasUpstream: true,
  files: [],
  repoRoot
})

/** A port the test reads and drives: every call recorded, `refuse` thrown
 *  by the next call. */
class FakeGit implements GitService {
  readonly calls: Array<{ method: string; args: unknown[] }> = []
  readonly listeners = new Set<(event: GitEvent) => void>()
  refuse: unknown = null

  private async record<T>(method: string, result: T, ...args: unknown[]): Promise<T> {
    this.calls.push({ method, args })
    const refusal = this.refuse
    if (refusal !== null) {
      this.refuse = null
      throw refusal
    }
    return result
  }
  status: GitOperations['status'] = (cwd) => this.record('status', aStatus(cwd), cwd)
  statusBatch: GitOperations['statusBatch'] = (paths) =>
    this.record(
      'statusBatch',
      paths.map((path) => ({ path, status: aStatus(path) })),
      paths
    )
  discover: GitOperations['discover'] = (cwd, force) =>
    this.record(
      'discover',
      { repos: [{ name: 'nested', path: `${cwd}/nested` }], truncated: false },
      cwd,
      force
    )
  checkIgnored: GitOperations['checkIgnored'] = (cwd, paths) =>
    this.record('checkIgnored', [paths[0] ?? ''], cwd, paths)
  fetch: GitOperations['fetch'] = (cwd) => this.record('fetch', undefined, cwd)
  fetchBatch: GitOperations['fetchBatch'] = (paths) => this.record('fetchBatch', undefined, paths)
  refreshRemotes: GitOperations['refreshRemotes'] = (paths, batchId) =>
    this.record(
      'refreshRemotes',
      paths.map((repoPath) => ({ repoPath, error: null })),
      paths,
      batchId
    )
  watch: GitOperations['watch'] = (subscriberId, paths) =>
    this.record('watch', [...paths], subscriberId, paths)
  unwatch: GitOperations['unwatch'] = (subscriberId) =>
    this.record('unwatch', undefined, subscriberId)
  stage: GitOperations['stage'] = (cwd, files) => this.record('stage', undefined, cwd, files)
  unstage: GitOperations['unstage'] = (cwd, files) => this.record('unstage', undefined, cwd, files)
  discard: GitOperations['discard'] = (cwd, files: ReadonlyArray<GitDiscardFile>) =>
    this.record('discard', undefined, cwd, files)
  commit: GitOperations['commit'] = (cwd, message) =>
    this.record('commit', { hash: 'abc123', branch: 'main' }, cwd, message)
  push: GitOperations['push'] = (cwd) => this.record('push', undefined, cwd)
  publishBranch: GitOperations['publishBranch'] = (cwd) =>
    this.record('publishBranch', undefined, cwd)
  pull: GitOperations['pull'] = (cwd, strategy?: GitPullStrategy) =>
    this.record('pull', undefined, cwd, strategy)
  diff: GitOperations['diff'] = (cwd, filePath, staged, isUntracked) =>
    this.record('diff', '--- a\n+++ b\n', cwd, filePath, staged, isUntracked)
  rangeFiles: GitOperations['rangeFiles'] = (cwd, direction: GitRangeDirection) =>
    this.record('rangeFiles', [], cwd, direction)
  rangeDiff: GitOperations['rangeDiff'] = (cwd, direction, filePath) =>
    this.record('rangeDiff', '', cwd, direction, filePath)
  commitFiles: GitOperations['commitFiles'] = (cwd, hash) =>
    this.record('commitFiles', [], cwd, hash)
  commitDiff: GitOperations['commitDiff'] = (cwd, hash, filePath) =>
    this.record('commitDiff', '', cwd, hash, filePath)
  log: GitOperations['log'] = (cwd, maxCount) =>
    this.record(
      'log',
      [{ hash: 'abc123', shortHash: 'abc', message: 'init', author: 'a', date: 'd', refs: [] }],
      cwd,
      maxCount
    )
  outgoing: GitOperations['outgoing'] = (cwd) => this.record('outgoing', [], cwd)
  incoming: GitOperations['incoming'] = (cwd) => this.record('incoming', [], cwd)
  journey: GitOperations['journey'] = (cwd, maxCount) =>
    this.record(
      'journey',
      { local: [], pushGroups: [], fallbackMode: false, branch: 'main', hasMore: false },
      cwd,
      maxCount
    )
  generateCommitMessage: GitOperations['generateCommitMessage'] = (cwd) =>
    this.record('generateCommitMessage', 'feat: generated', cwd)
  summarizePush: GitOperations['summarizePush'] = (cwd, commitMessages, diffStats) =>
    this.record('summarizePush', { title: 't', description: 'd' }, cwd, commitMessages, diffStats)
  magicSync: GitOperations['magicSync'] = (paths, batchId) =>
    this.record(
      'magicSync',
      paths.map((repoPath) => ({ repoPath, actions: ['committed'], error: null })),
      paths,
      batchId
    )
  magicPull: GitOperations['magicPull'] = (paths, batchId) =>
    this.record(
      'magicPull',
      paths.map((repoPath) => ({ repoPath, pulled: true, error: null })),
      paths,
      batchId
    )
  subscribe = (listener: (event: GitEvent) => void): Unsubscribe => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  emit(event: GitEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

let server: EmbeddedServer
let fake: FakeGit

const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json'
})
const get = (path: string): Promise<Response> =>
  fetch(`${server.url}${path}`, { headers: headers(server.token) })
const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: headers(server.token),
    body: JSON.stringify(body)
  })
const welcomed = async (): Promise<Peer> => {
  const peer = new Peer(server.url.replace('http', 'ws') + '/push')
  await peer.opened
  peer.send({ _tag: 'hello', token: server.token, client: 'test' })
  expect(await peer.next()).toMatchObject({ _tag: 'welcome', serverId: server.serverId })
  return peer
}

beforeEach(async () => {
  fake = new FakeGit()
  server = await startEmbedded({
    ports: { sessions: new FakeSource(), git: fake },
    helloTimeoutMs: 200
  })
})
afterEach(async () => {
  await server.stop()
})

describe('the git group of the HTTP API', () => {
  it('reads a status for the folder asked, as the port answers it', async () => {
    const response = await get('/git/status?cwd=%2Fsrv%2Frepo')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(aStatus('/srv/repo'))
    expect(fake.calls).toEqual([{ method: 'status', args: ['/srv/repo'] }])
  })

  it('reads a batch of statuses from a POST body, one entry per path', async () => {
    const response = await post('/git/status-batch', { paths: ['/srv/a', '/srv/b'] })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      { path: '/srv/a', status: aStatus('/srv/a') },
      { path: '/srv/b', status: aStatus('/srv/b') }
    ])
  })

  it('decodes a GET’s flags and numbers before the port sees them', async () => {
    expect((await get('/git/discover?cwd=%2Fsrv&force=true')).status).toBe(200)
    expect(
      (await get('/git/diff?cwd=%2Fsrv%2Frepo&filePath=a.ts&staged=false&isUntracked=true')).status
    ).toBe(200)
    expect((await get('/git/log?cwd=%2Fsrv%2Frepo&maxCount=5')).status).toBe(200)
    expect((await get('/git/log?cwd=%2Fsrv%2Frepo')).status).toBe(200)
    expect(fake.calls).toEqual([
      { method: 'discover', args: ['/srv', true] },
      { method: 'diff', args: ['/srv/repo', 'a.ts', false, true] },
      { method: 'log', args: ['/srv/repo', 5] },
      { method: 'log', args: ['/srv/repo', undefined] }
    ])
  })

  it('hands a commit its folder and message and answers the commit', async () => {
    const response = await post('/git/commit', { cwd: '/srv/repo', message: 'feat: x' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ hash: 'abc123', branch: 'main' })
    expect(fake.calls).toEqual([{ method: 'commit', args: ['/srv/repo', 'feat: x'] }])
  })

  it('reaches the port for the writes, the watch and the batches with their lists', async () => {
    expect((await post('/git/stage', { cwd: '/srv/repo', files: ['a.ts'] })).status).toBe(204)
    expect((await post('/git/pull', { cwd: '/srv/repo', strategy: 'rebase' })).status).toBe(204)
    expect((await post('/git/push', { cwd: '/srv/repo' })).status).toBe(204)
    expect(
      (await post('/git/watch', { subscriberId: 'mac-1:git-status-1', paths: ['/srv/repo'] }))
        .status
    ).toBe(200)
    expect((await post('/git/unwatch', { subscriberId: 'mac-1:git-status-1' })).status).toBe(204)
    const sync = await post('/git/magic-sync', { paths: ['/srv/repo'], batchId: 'mac-1:3' })
    expect(sync.status).toBe(200)
    expect(await sync.json()).toEqual([
      { repoPath: '/srv/repo', actions: ['committed'], error: null }
    ])
    expect(fake.calls.at(-1)).toEqual({ method: 'magicSync', args: [['/srv/repo'], 'mac-1:3'] })
    expect(fake.calls.map((c) => c.method)).toEqual([
      'stage',
      'pull',
      'push',
      'watch',
      'unwatch',
      'magicSync'
    ])
    expect(fake.calls[1].args).toEqual(['/srv/repo', 'rebase'])
    expect(fake.calls[3].args).toEqual(['mac-1:git-status-1', ['/srv/repo']])
  })

  it('answers git’s refusal as the declared GitOperationFailed with git’s sentence', async () => {
    class GitError extends Error {}
    fake.refuse = new GitError('fatal: nothing to commit, working tree clean')
    const response = await post('/git/commit', { cwd: '/srv/repo', message: 'x' })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      _tag: 'GitOperationFailed',
      message: 'fatal: nothing to commit, working tree clean'
    })
  })

  it('answers a CapabilityUnavailable the port throws as that failure', async () => {
    fake.refuse = new CapabilityUnavailable({ capability: 'git', message: 'No git here' })
    const response = await get('/git/status?cwd=%2Fsrv%2Frepo')
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'git',
      message: 'No git here'
    })
  })

  it('refuses an invalid payload before the port sees it', async () => {
    expect((await post('/git/commit', { cwd: '', message: 'x' })).status).toBe(400)
    expect((await get('/git/log?cwd=%2Fsrv&maxCount=zero')).status).toBe(400)
    expect(fake.calls).toEqual([])
  })

  it('publishes the port’s news to an attached client', async () => {
    const peer = await welcomed()
    fake.emit({ _tag: 'git.repos_changed', repos: ['/srv/repo'] })
    const changed = JSON.stringify(await peer.next())
    expect(changed).toContain('"git.repos_changed"')
    expect(changed).toContain('"/srv/repo"')
    fake.emit({
      _tag: 'git.batch_progress',
      op: 'sync',
      phase: 'generating',
      repoPath: '/srv/repo',
      repoName: 'repo',
      done: 0,
      total: 1,
      batchId: 'mac-1:3'
    })
    const progress = JSON.stringify(await peer.next())
    expect(progress).toContain('"git.batch_progress"')
    expect(progress).toContain('"generating"')
    expect(progress).toContain('"mac-1:3"')
    peer.ws.close()
  })
})

describe('a server without a git port', () => {
  it('says it has no git service rather than answering for a folder it never saw', async () => {
    await server.stop()
    server = await startEmbedded({ ports: { sessions: new FakeSource() }, helloTimeoutMs: 200 })
    const response = await get('/git/status?cwd=%2Fsrv%2Frepo')
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'git',
      message: 'This server has no git service.'
    })
  })
})
