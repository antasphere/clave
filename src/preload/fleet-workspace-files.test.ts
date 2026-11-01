import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { Backing } from '@clave/client/router'
import type { ServerEvent, ServerEventEnvelope } from '@clave/contract/events'
import { resourceKey } from '@clave/contract/fleet'
import { createFleetDesktop } from './fleet-desktop'
import type { ElectronAPI } from './index.d'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}
const file = (owner: string, path = '/repo'): string => resourceKey('file', owner, path)
interface Fixture {
  api: ElectronAPI
  local: ElectronAPI
  calls: Array<{ owner: string; method: string; args: unknown[] }>
  invoke: Mock<(channel: string, ...args: unknown[]) => Promise<unknown>>
  pendingReads: Map<string, (value: null) => void>
  failures: Map<string, Error>
  holds: Map<string, Promise<void>>
  welcomes: Map<string, Promise<void>>
  emit: (owner: string, event: ServerEvent) => void
  reconnect: (owner: string) => void
}
function fixture(): Fixture {
  const calls: Array<{ owner: string; method: string; args: unknown[] }> = []
  const pendingReads = new Map<string, (value: null) => void>()
  const statuses = new Map<string, (s: string, d: object) => void>()
  const events = new Map<string, (e: ServerEventEnvelope) => void>()
  const failures = new Map<string, Error>()
  const holds = new Map<string, Promise<void>>()
  const welcomes = new Map<string, Promise<void>>()
  const local = {
    sessionsFiles: {},
    watchDir: vi.fn(async () => {}),
    unwatchDir: vi.fn(async () => {}),
    onFsChanged: vi.fn(() => vi.fn()),
    onClaveFileChanged: vi.fn(() => vi.fn()),
    readClaveFile: vi.fn(async () => null),
    writeClaveFile: vi.fn(async () => {}),
    discoverClaveFiles: vi.fn(async () => []),
    discoverClaveFilesRecursive: vi.fn(async () => []),
    readAutoDiscoverConfig: vi.fn(async () => null),
    claveFileExists: vi.fn(async () => true),
    watchClaveFile: vi.fn(async () => {}),
    unwatchClaveFile: vi.fn(async () => {}),
    trustWorkspaceRoot: vi.fn(async () => {}),
    untrustWorkspaceRoot: vi.fn(async () => {}),
    listTrustedRoots: vi.fn(async () => ['/mac']),
    existsSync: vi.fn(() => true)
  }
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'server:fleet:list')
      return ['x', 'y'].map((id) => ({
        id,
        name: `Server ${id}`,
        enabled: true,
        url: `http://${id}`
      }))
    if (channel === 'clave:review-dialog') return { response: 0, checkboxChecked: true }
    return { url: `http://${args[0]}`, token: 'test-only' }
  })
  const call =
    (owner: string, method: string, result?: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ owner, method, args })
      await holds.get(`${owner}:${method}`)
      if (failures.has(`${owner}:${method}`)) throw failures.get(`${owner}:${method}`)
      return result
    }
  const api = createFleetDesktop(local as unknown as ElectronAPI, {
    invoke,
    changed: () => () => {},
    connect: async (endpoint) => {
      const owner = new URL(endpoint.url).hostname
      return {
        api: {
          dispose: async () => {},
          sessions: { list: async () => [], listAdoptable: async () => [] },
          sidebar: {
            getLayout: async () => ({
              windowKey: 'server',
              revision: 0,
              groups: [],
              displayOrder: []
            })
          },
          requests: { watch: () => () => {} },
          files: {
            syncWatch: call(owner, 'sync', { watched: ['.'] }),
            listAll: call(owner, 'all', { files: ['a.txt'], truncated: false }),
            list: call(owner, 'list', {
              entries: [
                { name: 'node_modules' },
                { name: 'a.txt', path: 'a.txt', type: 'file', size: 1 }
              ]
            })
          },
          workspaceFiles: {
            read: (path: string, options: { requestId: string }) => {
              calls.push({ owner, method: 'read', args: [path, options] })
              return new Promise((r) => pendingReads.set(owner, r))
            },
            write: call(owner, 'write'),
            discover: call(owner, 'discover', [
              { name: 'default', path: '/repo/default.clave', rootDir: '/repo' }
            ]),
            discoverRecursive: call(owner, 'recursive', [
              { name: 'nested', path: '/repo/sub/default.clave', rootDir: '/repo/sub' }
            ]),
            autoDiscover: call(owner, 'auto', { enabled: true }),
            exists: call(owner, 'exists', true),
            watch: call(owner, 'watch'),
            unwatch: call(owner, 'unwatch'),
            trustRoot: call(owner, 'trust'),
            untrustRoot: call(owner, 'untrust'),
            trustedRoots: async () => {
              if (holds.has(`${owner}:roots`)) throw new Error('offline')
              return [`/${owner}/trusted`]
            },
            answerReview: call(owner, 'answer')
          }
        },
        push: {
          status: 'open',
          connect: () => {},
          close: () => {},
          onRequest: () => () => {},
          whenOpen: () => welcomes.get(owner) ?? Promise.resolve(),
          onStatus: (cb: (s: string, d: object) => void) => {
            statuses.set(owner, cb)
            return () => {}
          },
          onEvent: (cb: (e: ServerEventEnvelope) => void) => {
            events.set(owner, cb)
            return () => {}
          }
        }
      } as unknown as Backing
    }
  })
  const emit = (owner: string, event: ServerEvent): void =>
    events.get(owner)!({ id: 'test', seq: 1, at: 1, event })
  const reconnect = (owner: string): void => {
    statuses.get(owner)!('reconnecting', {})
    statuses.get(owner)!('open', {})
  }
  return {
    api,
    local: local as unknown as ElectronAPI,
    calls,
    invoke,
    pendingReads,
    holds,
    failures,
    welcomes,
    emit,
    reconnect
  }
}
let h: ReturnType<typeof fixture>
beforeEach(async () => {
  vi.useFakeTimers()
  h = fixture()
  await h.api.fleetList()
  await flush()
})
afterEach(async () => {
  await h.api.unwatchDir()
  await h.api.fleetDisconnect('x')
  await h.api.fleetDisconnect('y')
  vi.useRealTimers()
})
const syncs = (): Fixture['calls'] => h.calls.filter((c) => c.method === 'sync')

describe('the window tree watch', () => {
  it('logs each failed server watch send and keeps watch/unwatch and later Mac watches usable', async () => {
    const error = Object.assign(new Error('server unreachable'), {
      detail: 'PRIVATE SERVER DETAIL',
      stack: 'PRIVATE STACK'
    })
    h.failures.set('x:sync', error)
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(h.api.watchDir(file('x'), ['a'])).resolves.toBeUndefined()
      await expect(h.api.unwatchDir()).resolves.toBeUndefined()
      await h.api.watchDir('/mac', ['src'])
      expect(h.local.watchDir).toHaveBeenCalledWith('/mac', ['src'])
      expect(log.mock.calls).toEqual([
        ['[clave] folder watch not sent to the server', 'server unreachable'],
        ['[clave] folder watch not sent to the server', 'server unreachable']
      ])
      expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE')
    } finally {
      h.failures.delete('x:sync')
      await h.api.unwatchDir()
      log.mockRestore()
    }
  })
  it('preserves the rejection of a Mac watch and unwatch', async () => {
    const error = new Error('local watch failed')
    vi.mocked(h.local.watchDir).mockRejectedValueOnce(error)
    await expect(h.api.watchDir('/mac', ['src'])).rejects.toBe(error)
    vi.mocked(h.local.unwatchDir).mockRejectedValueOnce(error)
    await expect(h.api.unwatchDir()).rejects.toBe(error)
  })
  it('moves Mac → X → Y → Mac with whole state and rising generations', async () => {
    await h.api.watchDir('/mac', ['src'])
    await h.api.watchDir(file('x'), ['a'])
    await h.api.watchDir(file('y'), ['b'])
    await h.api.watchDir('/mac', [])
    expect(h.local.unwatchDir).toHaveBeenCalledOnce()
    expect(h.local.watchDir).toHaveBeenCalledTimes(2)
    expect(syncs().map((c) => [c.owner, c.args[0]])).toMatchObject([
      ['x', { generation: 2, tree: { root: '/repo', dirs: ['a'] } }],
      ['x', { generation: 3, tree: null }],
      ['y', { generation: 3, tree: { root: '/repo', dirs: ['b'] } }],
      ['y', { generation: 4, tree: null }]
    ])
  })
  it('an unwatch while a sync is in flight wins and reconnect sends the latest state', async () => {
    let release!: () => void
    h.holds.set(
      'x:sync',
      new Promise<void>((r) => {
        release = r
      })
    )
    const watch = h.api.watchDir(file('x'), ['a'])
    await flush()
    const unwatch = h.api.unwatchDir()
    release()
    await Promise.all([watch, unwatch])
    expect(syncs().at(-1)?.args[0]).toMatchObject({ generation: 2, tree: null })
    h.reconnect('x')
    await flush()
    expect(syncs().at(-1)?.args[0]).toMatchObject({ generation: 2, tree: null })
  })
  it('filters namespaces and old trees, rereads on reconnect and renews only on a server', async () => {
    const cb = vi.fn()
    const off = h.api.onFsChanged(cb)
    await h.api.watchDir(file('x'), ['a'])
    const namespace = (syncs()[0].args[0] as { namespace: string }).namespace
    const change = { _tag: 'files.dirs_changed' as const, namespace, root: '/repo', dirs: ['a'] }
    h.emit('x', { ...change, namespace: 'another' })
    h.emit('y', change)
    h.emit('x', { ...change, root: '/old' })
    expect(cb).not.toHaveBeenCalled()
    h.emit('x', change)
    expect(cb).toHaveBeenCalledWith(file('x'), ['a'])
    cb.mockClear()
    h.reconnect('x')
    await flush()
    expect(cb).toHaveBeenCalledExactlyOnceWith(file('x'), ['.', 'a'])
    const before = syncs().length
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(syncs()).toHaveLength(before + 1)
    await h.api.watchDir('/mac', [])
    const stopped = syncs().length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(syncs()).toHaveLength(stopped)
    h.emit('x', change)
    expect(cb).toHaveBeenCalledTimes(1)
    off()
  })
  it('uses listAll, filters shared ignored names, and keeps existsSync local', async () => {
    expect(await h.api.listFiles(file('x'))).toEqual({ files: ['a.txt'], truncated: false })
    expect(await h.api.readDir(file('x'), '.')).toMatchObject([{ name: 'a.txt' }])
    expect(h.api.existsSync(file('x'), 'slideless.json')).toBe(false)
    expect(h.local.existsSync).not.toHaveBeenCalled()
    expect(h.api.existsSync('/mac', 'slideless.json')).toBe(true)
  })
})

describe('workspace files belong to their owner', () => {
  it('wraps discoveries and unwraps read/write roots, refusing mixed owners', async () => {
    expect(await h.api.discoverClaveFiles(file('x'))).toEqual([
      { name: 'default', path: file('x', '/repo/default.clave'), rootDir: file('x') }
    ])
    expect(await h.api.discoverClaveFilesRecursive(file('x'))).toEqual([
      {
        name: 'nested',
        path: file('x', '/repo/sub/default.clave'),
        rootDir: file('x', '/repo/sub')
      }
    ])
    const read = h.api.readClaveFile(file('x', '/repo/default.clave'), file('x'))
    await flush()
    expect(h.calls.find((c) => c.method === 'read')?.args).toMatchObject([
      '/repo/default.clave',
      { rootDir: '/repo', requestId: expect.any(String) }
    ])
    h.pendingReads.get('x')!(null)
    await read
    await h.api.writeClaveFile(
      file('x', '/repo/default.clave'),
      { name: 'new', sessions: [], terminals: [] },
      file('x')
    )
    expect(h.calls.find((c) => c.method === 'write')?.args).toMatchObject([
      '/repo/default.clave',
      { name: 'new' },
      '/repo'
    ])
    for (const root of ['/repo', file('y')]) {
      await expect(h.api.readClaveFile(file('x', '/repo/default.clave'), root)).rejects.toThrow(
        'different server owners'
      )
      await expect(
        h.api.writeClaveFile(
          file('x', '/repo/default.clave'),
          { name: 'new', sessions: [], terminals: [] },
          root
        )
      ).rejects.toThrow('different server owners')
    }
    await h.api.readClaveFile('/mac/default.clave', '/mac')
    expect(h.local.readClaveFile).toHaveBeenCalledWith('/mac/default.clave', '/mac')
  })
  it('waits for welcome, shows only this owner/request review and answers its owner', async () => {
    let welcome!: () => void
    h.welcomes.set(
      'x',
      new Promise<void>((r) => {
        welcome = r
      })
    )
    const read = h.api.readClaveFile(file('x', '/repo/default.clave'), file('x'))
    await flush()
    expect(h.calls.filter((c) => c.method === 'read')).toEqual([])
    welcome()
    await flush()
    const requestId = (h.calls.find((c) => c.method === 'read')!.args[1] as { requestId: string })
      .requestId
    const review = {
      _tag: 'workspace_files.review_needed' as const,
      requestId,
      reviewId: 'r',
      path: '/repo/default.clave',
      folder: '/repo',
      autoCommands: ['run'],
      prompts: [],
      dangerous: false
    }
    h.emit('y', review)
    h.emit('x', { ...review, requestId: 'other' })
    await flush()
    expect(h.invoke.mock.calls.filter((c) => c[0] === 'clave:review-dialog')).toEqual([])
    h.emit('x', review)
    await flush()
    expect(h.invoke).toHaveBeenCalledWith(
      'clave:review-dialog',
      expect.objectContaining({ server: 'Server x', path: '/repo/default.clave' })
    )
    expect(h.calls.filter((c) => c.method === 'answer')).toEqual([
      { owner: 'x', method: 'answer', args: ['r', { response: 0, checkboxChecked: true }] }
    ])
    h.pendingReads.get('x')!(null)
    await read
    h.emit('x', review)
    await flush()
    expect(h.calls.filter((c) => c.method === 'answer')).toHaveLength(1)
  })
  it('fails a read after the welcome deadline', async () => {
    h.welcomes.set('x', new Promise(() => {}))
    const read = h.api.readClaveFile(file('x', '/repo/default.clave'))
    const failed = expect(read).rejects.toThrow('push channel did not open in time')
    await vi.advanceTimersByTimeAsync(15_000)
    await failed
    expect(h.calls.filter((c) => c.method === 'read')).toEqual([])
  })
  it('serializes file watch changes per owner and re-watches at reconnect', async () => {
    let release!: () => void
    h.holds.set(
      'x:watch',
      new Promise<void>((r) => {
        release = r
      })
    )
    const watch = h.api.watchClaveFile(file('x', '/repo/a.clave'))
    const unwatch = h.api.unwatchClaveFile(file('x', '/repo/a.clave'))
    const next = h.api.watchClaveFile(file('x', '/repo/b.clave'))
    await flush()
    expect(h.calls.filter((c) => ['watch', 'unwatch'].includes(c.method))).toHaveLength(1)
    release()
    await Promise.all([watch, unwatch, next])
    h.reconnect('x')
    await flush()
    const calls = h.calls.filter((c) => ['watch', 'unwatch'].includes(c.method))
    expect(calls.map((c) => [c.method, c.args[0]])).toEqual([
      ['watch', '/repo/a.clave'],
      ['unwatch', '/repo/a.clave'],
      ['watch', '/repo/b.clave'],
      ['watch', '/repo/b.clave']
    ])
    expect(calls.every((c) => String(c.args[1]).startsWith('fleet:'))).toBe(true)
    const cb = vi.fn()
    const off = h.api.onClaveFileChanged(cb)
    h.emit('y', { _tag: 'workspace_files.changed', path: '/repo/b.clave' })
    expect(cb).toHaveBeenCalledWith(file('y', '/repo/b.clave'))
    off()
  })
  it('merges trusted roots, skips a failed server, and routes grants and revocations', async () => {
    expect(await h.api.listTrustedRoots()).toEqual([
      '/mac',
      file('x', '/x/trusted'),
      file('y', '/y/trusted')
    ])
    h.holds.set('y:roots', Promise.resolve())
    expect(await h.api.listTrustedRoots()).toEqual(['/mac', file('x', '/x/trusted')])
    await h.api.trustWorkspaceRoot(file('x'))
    await h.api.untrustWorkspaceRoot(file('y'))
    expect(h.calls.filter((c) => ['trust', 'untrust'].includes(c.method))).toEqual([
      { owner: 'x', method: 'trust', args: ['/repo'] },
      { owner: 'y', method: 'untrust', args: ['/repo'] }
    ])
    await h.api.fleetDisconnect('y')
    expect(await h.api.listTrustedRoots()).toEqual(['/mac', file('x', '/x/trusted')])
  })
})
