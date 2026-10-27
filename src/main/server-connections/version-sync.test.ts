/**
 * The Mac's version sync (issue #266): the pure rule that decides what a
 * saved server's version means against this app's, and the loop that reads
 * every enabled server and asks an older one, once per version, to upgrade
 * to exactly the app's version once idle. A dev build never asks.
 */
import { describe, expect, it } from 'vitest'
import type {
  SavedServerConnection,
  ServerVersionDecision,
  ServerVersionStatus
} from '../../../packages/contract/src/fleet'
import type { ServerInfo, ServerUpgradeStatus } from '../../../packages/contract/src/server-info'
import {
  UPGRADE_POLL_MS,
  VERSION_SYNC_INTERVAL_MS,
  createVersionSync,
  decideServerVersion,
  manualUpgradeCommand,
  type ServerRead,
  type VersionSync
} from './version-sync'

const IDLE: ServerUpgradeStatus = { supported: true, state: 'idle' }
const info = (version: string, overrides: Partial<ServerInfo> = {}): ServerRead => ({
  kind: 'info',
  info: { version, installRef: `v${version}`, upgrade: IDLE, ...overrides }
})
const decide = (
  server: ServerRead,
  appVersion = '3.0.0-beta.9',
  extra: { automatic?: boolean; requested?: string } = {}
): ServerVersionDecision =>
  decideServerVersion({
    appVersion,
    automatic: extra.automatic ?? true,
    server,
    requested: extra.requested
  })

describe('the decision for one server', () => {
  it('matches a server on the app version', () => {
    expect(decide(info('3.0.0-beta.9'))).toMatchObject({
      kind: 'match',
      serverVersion: '3.0.0-beta.9'
    })
  })

  it('upgrades an older server installed from a release tag, to exactly the app version', () => {
    expect(decide(info('3.0.0-beta.8'))).toEqual({
      kind: 'upgrade',
      appVersion: '3.0.0-beta.9',
      automatic: true,
      serverVersion: '3.0.0-beta.8',
      installRef: 'v3.0.0-beta.8',
      target: '3.0.0-beta.9'
    })
  })

  it('orders prereleases by semver', () => {
    expect(decide(info('3.0.0-beta.10'), '3.0.0-beta.9').kind).toBe('server-newer')
    expect(decide(info('3.0.0-beta.9'), '3.0.0').kind).toBe('upgrade')
    expect(decide(info('3.0.0'), '3.0.0-beta.9').kind).toBe('server-newer')
    expect(decide(info('2.9.9'), '3.0.0-beta.1').kind).toBe('upgrade')
  })

  it('never downgrades a newer server', () => {
    expect(decide(info('3.1.0'), '3.0.0')).toMatchObject({
      kind: 'server-newer',
      serverVersion: '3.1.0'
    })
  })

  it('leaves a server installed from a branch or a custom ref alone, whatever its version', () => {
    for (const installRef of ['dev', 'main', 'feature/x', 'v3.0', 'deadbeef', null])
      expect(decide(info('2.4.0', { installRef }), '3.0.0')).toMatchObject({
        kind: 'custom-ref',
        installRef
      })
  })

  it('shows the manual command for a server without the endpoint', () => {
    expect(decide({ kind: 'missing' }, '3.0.0-beta.9')).toEqual({
      kind: 'manual',
      appVersion: '3.0.0-beta.9',
      automatic: true,
      command: 'bash ~/install-server.sh --ref v3.0.0-beta.9'
    })
    expect(manualUpgradeCommand('3.0.0')).toBe('bash ~/install-server.sh --ref v3.0.0')
  })

  it('names why a server cannot upgrade itself', () => {
    expect(
      decide(
        info('3.0.0-beta.8', {
          installRef: null,
          upgrade: { supported: false, reason: 'not installed by install-server.sh', state: 'idle' }
        })
      )
    ).toMatchObject({
      kind: 'unsupported',
      reason: 'not installed by install-server.sh',
      serverVersion: '3.0.0-beta.8',
      command: 'bash ~/install-server.sh --ref v3.0.0-beta.9'
    })
  })

  it('gives an app-run server no command: it updates with the app (V1-F1)', () => {
    const decided = decide(
      info('3.0.0-beta.9', {
        installRef: null,
        upgrade: {
          supported: false,
          reason: 'This server is run by the app; it updates with it',
          state: 'idle'
        }
      })
    )
    expect(decided).toMatchObject({ kind: 'unsupported' })
    expect(decided).not.toHaveProperty('command')
  })

  it('compares the versions first: a server as new as the app or newer is never upgrading or failed (V1-F2)', () => {
    const at = (version: string, upgrade: ServerUpgradeStatus): ServerRead =>
      info(version, { upgrade })
    // Another Mac on beta.10 failed on, or waits with, a server already on beta.9.
    for (const upgrade of [
      { supported: true, state: 'failed', target: '3.0.0-beta.10', error: 'x' },
      { supported: true, state: 'waiting-for-idle', target: '3.0.0-beta.10' },
      { supported: true, state: 'running', target: '3.0.0-beta.10' }
    ] as ServerUpgradeStatus[]) {
      expect(decide(at('3.0.0-beta.9', upgrade), '3.0.0-beta.8').kind).toBe('server-newer')
      expect(decide(at('3.0.0-beta.9', upgrade), '3.0.0-beta.9').kind).toBe('match')
    }
  })

  it('knows nothing of a server that does not answer', () => {
    expect(decide({ kind: 'unreachable' })).toEqual({
      kind: 'unreachable',
      appVersion: '3.0.0-beta.9',
      automatic: true
    })
  })

  it('reads a wait or a run for the app version, or a later one, as upgrading', () => {
    const waiting = info('3.0.0-beta.8', {
      upgrade: {
        supported: true,
        state: 'waiting-for-idle',
        target: '3.0.0-beta.9',
        mode: 'when-idle'
      }
    })
    expect(decide(waiting)).toMatchObject({
      kind: 'upgrading',
      target: '3.0.0-beta.9',
      upgradeState: 'waiting-for-idle'
    })
    const running = info('3.0.0-beta.8', {
      upgrade: { supported: true, state: 'running', target: '3.0.0-beta.9', mode: 'now' }
    })
    expect(decide(running)).toMatchObject({ kind: 'upgrading', upgradeState: 'running' })
    // Another Mac on a later version asked first: no tug of war.
    const later = info('3.0.0-beta.8', {
      upgrade: { supported: true, state: 'waiting-for-idle', target: '3.0.0-beta.10' }
    })
    expect(decide(later)).toMatchObject({ kind: 'upgrading', target: '3.0.0-beta.10' })
    // An earlier target is replaced by this app's.
    const earlier = info('3.0.0-beta.7', {
      upgrade: { supported: true, state: 'waiting-for-idle', target: '3.0.0-beta.8' }
    })
    expect(decide(earlier)).toMatchObject({ kind: 'upgrade', target: '3.0.0-beta.9' })
  })

  it('reports a failed attempt for the app version with its error, and does not ask again', () => {
    const failed = info('3.0.0-beta.8', {
      upgrade: { supported: true, state: 'failed', target: '3.0.0-beta.9', error: 'npm ERR! build' }
    })
    expect(decide(failed)).toMatchObject({
      kind: 'failed',
      target: '3.0.0-beta.9',
      error: 'npm ERR! build'
    })
    const olderFailure = info('3.0.0-beta.7', {
      upgrade: { supported: true, state: 'failed', target: '3.0.0-beta.8', error: 'x' }
    })
    expect(decide(olderFailure).kind).toBe('upgrade')
  })

  it('reads a server still older after this app asked as a failed upgrade', () => {
    expect(
      decide(info('3.0.0-beta.8'), '3.0.0-beta.9', { requested: '3.0.0-beta.9' })
    ).toMatchObject({
      kind: 'failed',
      target: '3.0.0-beta.9',
      error: expect.stringContaining('upgrade.log')
    })
  })

  it('carries whether this app upgrades servers at all', () => {
    expect(decide(info('3.0.0-beta.8'), '3.0.0-beta.9', { automatic: false })).toMatchObject({
      kind: 'upgrade',
      automatic: false
    })
  })

  it('treats a server reporting a version that is not semver as a custom install', () => {
    expect(decide(info('3.0.0-beta.8', { version: 'nightly' })).kind).toBe('custom-ref')
  })
})

/** Servers the loop reads, with the answers and the requests recorded. */
interface Fleet {
  sync: VersionSync
  connections: SavedServerConnection[]
  requests: Array<{ id: string; version: string; when: 'idle' | 'now' }>
  published: ServerVersionStatus[][]
  intervals: Array<() => void>
  servers: Record<string, ServerRead>
  /** The pending short polls, by delay. */
  timeouts: Array<{ fn: () => void; ms: number }>
  reads: string[]
}
function fleet(
  servers: Record<string, ServerRead>,
  options: { automatic?: boolean; appVersion?: string } = {}
): Fleet {
  const connections: SavedServerConnection[] = Object.keys(servers).map((id) => ({
    id,
    name: id,
    url: `http://${id}`,
    enabled: true
  }))
  const requests: Array<{ id: string; version: string; when: 'idle' | 'now' }> = []
  const published: ServerVersionStatus[][] = []
  const intervals: Array<() => void> = []
  const timeouts: Array<{ fn: () => void; ms: number }> = []
  const reads: string[] = []
  const sync = createVersionSync({
    appVersion: () => options.appVersion ?? '3.0.0-beta.9',
    automatic: options.automatic ?? true,
    connections: () => connections,
    read: async (id) => {
      reads.push(id)
      return servers[id]
    },
    request: async (id, version, when) => {
      requests.push({ id, version, when })
      const status: ServerUpgradeStatus =
        when === 'now'
          ? { supported: true, state: 'running', target: version, mode: 'now' }
          : { supported: true, state: 'waiting-for-idle', target: version, mode: 'when-idle' }
      const current = servers[id]
      if (current.kind === 'info')
        servers[id] = { kind: 'info', info: { ...current.info, upgrade: status } }
      return status
    },
    publish: (results) => published.push(results),
    setInterval: (fn, ms) => {
      expect(ms).toBe(VERSION_SYNC_INTERVAL_MS)
      intervals.push(fn)
      return intervals.length
    },
    clearInterval: () => {
      intervals.length = 0
    },
    setTimeout: (fn, ms) => {
      const timeout = { fn, ms }
      timeouts.push(timeout)
      return timeout
    },
    clearTimeout: (handle) => {
      const i = timeouts.indexOf(handle as (typeof timeouts)[number])
      if (i >= 0) timeouts.splice(i, 1)
    }
  })
  return { sync, connections, requests, published, intervals, servers, timeouts, reads }
}

describe('the version sync loop', () => {
  it('asks an older server once to upgrade to the app version when idle, and publishes what it decided', async () => {
    const { sync, requests, published } = fleet({
      a: info('3.0.0-beta.8'),
      b: info('3.0.0-beta.9')
    })
    const results = await sync.refresh()
    expect(requests).toEqual([{ id: 'a', version: '3.0.0-beta.9', when: 'idle' }])
    expect(results.map((r) => [r.serverId, r.kind])).toEqual([
      ['a', 'upgrading'],
      ['b', 'match']
    ])
    expect(published.at(-1)).toEqual(results)
    await sync.refresh()
    await sync.refresh()
    expect(requests).toHaveLength(1)
  })

  it('never asks from a dev build', async () => {
    const { sync, requests } = fleet({ a: info('3.0.0-beta.8') }, { automatic: false })
    expect((await sync.refresh())[0]).toMatchObject({ kind: 'upgrade', automatic: false })
    expect(requests).toEqual([])
    await expect(sync.upgradeNow('a')).rejects.toThrow(/development build/)
    expect(requests).toEqual([])
  })

  it('never asks a newer server, a branch install, an old server or an unsupported one', async () => {
    const { sync, requests } = fleet({
      newer: info('3.1.0'),
      branch: info('2.4.0', { installRef: 'dev' }),
      old: { kind: 'missing' },
      hand: info('3.0.0-beta.8', {
        installRef: null,
        upgrade: { supported: false, reason: 'not installed by install-server.sh', state: 'idle' }
      }),
      gone: { kind: 'unreachable' }
    })
    expect((await sync.refresh()).map((r) => r.kind)).toEqual([
      'server-newer',
      'custom-ref',
      'manual',
      'unsupported',
      'unreachable'
    ])
    expect(requests).toEqual([])
  })

  it('leaves disconnected servers out', async () => {
    const { sync, connections, requests } = fleet({ a: info('3.0.0-beta.8') })
    connections[0] = { ...connections[0], enabled: false }
    expect(await sync.refresh()).toEqual([])
    expect(requests).toEqual([])
  })

  it('a server back on its old version after the ask reads as failed, and is not asked again', async () => {
    const { sync, requests, servers } = fleet({ a: info('3.0.0-beta.8') })
    await sync.refresh()
    servers.a = info('3.0.0-beta.8')
    expect((await sync.refresh())[0]).toMatchObject({ kind: 'failed' })
    expect(requests).toHaveLength(1)
  })

  it('upgrades now on demand, for an upgrade that waits or failed', async () => {
    const { sync, requests } = fleet({ a: info('3.0.0-beta.8') })
    await sync.refresh()
    expect(await sync.upgradeNow('a')).toMatchObject({ kind: 'upgrading', upgradeState: 'running' })
    expect(requests.at(-1)).toEqual({ id: 'a', version: '3.0.0-beta.9', when: 'now' })
  })

  it('never downgrades a newer server through upgrade now after another Mac failed (V1-F2)', async () => {
    for (const upgrade of [
      { supported: true, state: 'failed', target: '3.0.0-beta.10', error: 'build failed' },
      { supported: true, state: 'waiting-for-idle', target: '3.0.0-beta.10' }
    ] as ServerUpgradeStatus[]) {
      const { sync, requests } = fleet(
        { a: info('3.0.0-beta.9', { upgrade }) },
        { appVersion: '3.0.0-beta.8' }
      )
      expect((await sync.refresh())[0].kind).toBe('server-newer')
      await expect(sync.upgradeNow('a')).rejects.toThrow()
      expect(requests).toEqual([])
    }
  })

  it('refuses upgrade now for a branch install, whatever its version', async () => {
    const { sync, requests } = fleet({ a: info('2.4.0', { installRef: 'dev' }) })
    await sync.refresh()
    await expect(sync.upgradeNow('a')).rejects.toThrow()
    expect(requests).toEqual([])
  })

  it('refuses upgrade now when there is nothing to upgrade', async () => {
    const { sync, requests } = fleet({ a: info('3.0.0-beta.9'), b: info('3.1.0') })
    await sync.refresh()
    await expect(sync.upgradeNow('a')).rejects.toThrow()
    await expect(sync.upgradeNow('b')).rejects.toThrow()
    expect(requests).toEqual([])
  })

  it('reads again every five minutes once started, and stops', async () => {
    const { sync, intervals, published } = fleet({ a: info('3.0.0-beta.9') })
    sync.start()
    expect(intervals).toHaveLength(1)
    await sync.refresh()
    const before = published.length
    intervals[0]()
    await sync.refresh()
    expect(published.length).toBeGreaterThan(before)
    sync.stop()
    expect(intervals).toHaveLength(0)
  })

  it('a refused ask is reported as failed, with its message', async () => {
    const { sync } = fleet({ a: info('3.0.0-beta.8') })
    const failing = createVersionSync({
      appVersion: () => '3.0.0-beta.9',
      automatic: true,
      connections: () => [{ id: 'a', name: 'a', url: 'http://a', enabled: true }],
      read: async () => info('3.0.0-beta.8'),
      request: async () => {
        throw new Error('This server cannot upgrade itself: not installed by install-server.sh.')
      },
      publish: () => {}
    })
    void sync
    expect((await failing.refresh())[0]).toMatchObject({
      kind: 'failed',
      error: 'This server cannot upgrade itself: not installed by install-server.sh.'
    })
  })
})

describe('the Servers row follows an upgrade live (V1-F5)', () => {
  it('reads one server again on demand, and publishes it with the others', async () => {
    const { sync, published, reads, servers } = fleet({
      a: info('3.0.0-beta.9'),
      b: info('3.0.0-beta.8', {
        upgrade: { supported: true, state: 'waiting-for-idle', target: '3.0.0-beta.9' }
      })
    })
    await sync.refresh()
    reads.length = 0
    servers.b = info('3.0.0-beta.8', {
      upgrade: { supported: true, state: 'failed', target: '3.0.0-beta.9', error: 'npm ERR!' }
    })
    const results = await sync.refreshServer('b')
    expect(reads).toEqual(['b'])
    expect(results.map((r) => [r.serverId, r.kind])).toEqual([
      ['a', 'match'],
      ['b', 'failed']
    ])
    expect(published.at(-1)).toEqual(results)
  })

  it('polls a server every ten seconds while it waits or runs, and stops once it is done', async () => {
    const { sync, timeouts, reads, servers } = fleet({
      a: info('3.0.0-beta.9'),
      b: info('3.0.0-beta.8')
    })
    sync.start()
    await sync.refresh()
    // b was asked and now waits for idle: one short poll, for it alone.
    expect(timeouts.map((t) => t.ms)).toEqual([UPGRADE_POLL_MS])
    reads.length = 0
    servers.b = info('3.0.0-beta.8', {
      upgrade: { supported: true, state: 'running', target: '3.0.0-beta.9' }
    })
    timeouts.shift()!.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reads).toEqual(['b'])
    expect(timeouts.map((t) => t.ms)).toEqual([UPGRADE_POLL_MS])
    servers.b = info('3.0.0-beta.9')
    timeouts.shift()!.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sync.results().map((r) => r.kind)).toEqual(['match', 'match'])
    expect(timeouts).toEqual([])
    sync.stop()
  })

  it('does not poll before it is started, and stops polling when stopped', async () => {
    const { sync, timeouts } = fleet({ b: info('3.0.0-beta.8') })
    await sync.refresh()
    expect(timeouts).toEqual([])
    sync.start()
    await sync.refresh()
    expect(timeouts).toHaveLength(1)
    sync.stop()
    expect(timeouts).toEqual([])
  })
})
