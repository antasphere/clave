import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from './index.d'
import { resourceKey } from '../../packages/contract/src/fleet'

const mocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
  disabled: new Set<string>(),
  calls: [] as Array<{ owner: string; method: string; args: unknown[] }>,
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
  registries: new Map<string, Array<Record<string, unknown>>>(),
  revisions: new Map<string, number>(),
  /** Runs once before the next registry write lands: another Mac writing in between. */
  interleave: null as null | ((owner: string) => void),
  /** Holds the next registry reads until released, answering as `instance`. */
  held: [] as Array<{ release: () => void }>,
  hold: null as null | {
    instance: string
    revision: number
    workspaces?: Array<Record<string, unknown>>
  },
  events: new Map<string, (value: unknown) => void>()
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => mocks.exposed.set(name, value)
  },
  ipcRenderer: {
    invoke: mocks.invoke,
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  },
  webUtils: {}
}))
vi.mock('@clave/client/node', () => ({
  connectThroughNode: async (endpoint: { url: string }) => {
    const owner = endpoint.url.includes('owner-a') ? 'a' : 'b'
    const call =
      (method: string, result: unknown) =>
      async (...args: unknown[]) => {
        mocks.calls.push({ owner, method, args })
        return result
      }
    return {
      api: {
        dispose: async () => {},
        sessions: {
          history: call('history', { owner, items: [] }),
          list: call('list', []),
          listAdoptable: call('records', []),
          stop: call('stop', undefined)
        },
        sidebar: {
          getLayout: call('layout', {
            windowKey: 'server',
            revision: 0,
            groups: [],
            displayOrder: []
          })
        },
        settings: {
          workspaces: {
            load: async () => {
              const hold = mocks.hold
              if (hold) {
                const snapshot = [...(mocks.registries.get(owner) ?? [])]
                await new Promise<void>((release) => mocks.held.push({ release }))
                return {
                  workspaces: hold.workspaces ?? snapshot,
                  revision: hold.revision,
                  instance: hold.instance
                }
              }
              return {
                workspaces: mocks.registries.get(owner) ?? [],
                revision: mocks.revisions.get(owner) ?? 0,
                instance: owner
              }
            },
            updateRegistry: async (
              workspaces: Array<Record<string, unknown>>,
              _origin?: string,
              base?: { revision: number; instance: string }
            ) => {
              const hook = mocks.interleave
              mocks.interleave = null
              hook?.(owner)
              mocks.calls.push({ owner, method: 'update-registry', args: [workspaces] })
              const revision = mocks.revisions.get(owner) ?? 0
              if (base && (base.instance !== owner || base.revision !== revision))
                return { ok: false, reason: 'stale' }
              mocks.registries.set(owner, [...workspaces])
              mocks.revisions.set(owner, revision + 1)
              return { ok: true, workspaces, pins: [], revision: revision + 1, instance: owner }
            }
          }
        },
        files: {
          stat: async (location: { path: string }) => {
            mocks.calls.push({ owner, method: 'stat', args: [location] })
            return {
              type: location.path.endsWith('.txt') ? 'file' : 'directory',
              size: 0,
              modified: 0
            }
          },
          read: call('file-read', { content: owner, binary: false, truncated: false, size: 1 }),
          prepareAttachment: call('prepare', {
            id: 'file',
            path: '/remote/image.png',
            name: 'image.png',
            size: 8,
            mimeType: 'image/png',
            delivery: 'image'
          })
        },
        requests: { watch: () => () => {}, resolve: call('resolve', { accepted: true }) }
      },
      push: {
        status: 'open',
        connect: () => {},
        close: () => {},
        onStatus: () => () => {},
        onEvent: (callback: (value: unknown) => void) => {
          mocks.events.set(owner, callback)
          return () => {}
        },
        onRequest: () => () => {},
        whenOpen: async () => {},
        subscribe: () => () => {},
        subscribed: async (id: string) => ({ id })
      }
    }
  }
}))
let api: ElectronAPI
beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  mocks.calls.length = 0
  mocks.disabled.clear()
  mocks.events.clear()
  mocks.registries.clear()
  mocks.revisions.clear()
  mocks.interleave = null
  mocks.hold = null
  mocks.held.length = 0
  mocks.registries.set('a', [
    { id: 'ws-a', name: 'Repo', rootDir: '/srv/repo', profileFile: null, createdAt: 1 }
  ])
  mocks.registries.set('b', [
    { id: 'ws-a', name: 'Other', rootDir: '/home/b', profileFile: null, createdAt: 2 }
  ])
  mocks.invoke.mockReset().mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'server:fleet:list')
      return ['a', 'b'].map((id) => ({
        id,
        name: id,
        url: `http://owner-${id}`,
        enabled: !mocks.disabled.has(id)
      }))
    if (channel === 'server:fleet:disconnect') {
      mocks.disabled.add(String(args[0]))
      return null
    }
    if (channel === 'server:fleet:endpoint')
      return { url: `http://owner-${args[0]}`, token: 'test-only' }
    if (channel === 'sessions:history') return { owner: 'local', items: [] }
    if (channel === 'sessions:files')
      return { kind: 'upload', name: 'image.png', base64: 'aW1hZ2U=', image: false }
    return null
  })
  await import('./index')
  api = mocks.exposed.get('electronAPI') as ElectronAPI
  await api.fleetList()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('desktop owner routing', () => {
  it('routes colliding session IDs to exactly their owner and leaves local history local', async () => {
    for (const owner of ['a', 'b']) {
      expect(await api.sessionsHistory(resourceKey('session', owner, 'same'))).toMatchObject({
        owner
      })
    }
    expect(await api.sessionsHistory('same')).toMatchObject({ owner: 'local' })
    expect(mocks.calls.filter((c) => c.method === 'history')).toEqual([
      { owner: 'a', method: 'history', args: ['same', undefined, undefined] },
      { owner: 'b', method: 'history', args: ['same', undefined, undefined] }
    ])
  })
  it('does not send a remote stop to local IPC or another server', async () => {
    await api.killSession(resourceKey('session', 'b', 'same'))
    expect(mocks.calls.filter((c) => c.method === 'stop')).toEqual([
      { owner: 'b', method: 'stop', args: ['same'] }
    ])
    expect(mocks.invoke.mock.calls.filter(([channel]) => channel === 'pty:kill')).toEqual([])
  })
  it('converts selected Mac file bytes before preparing on the owning endpoint', async () => {
    await api.sessionsFiles.prepare(resourceKey('session', 'a', 'same'), { path: '/mac/image.png' })
    const prepare = mocks.calls.find((c) => c.method === 'prepare')
    expect(prepare).toEqual({
      owner: 'a',
      method: 'prepare',
      args: [
        {
          sessionId: 'same',
          source: { kind: 'upload', name: 'image.png', base64: 'aW1hZ2U=', image: false }
        }
      ]
    })
    expect(
      mocks.invoke.mock.calls.some(
        ([channel, request]) => channel === 'sessions:files' && request.type === 'prepare'
      )
    ).toBe(false)
  })
  it('routes identical file paths and request IDs independently by owner', async () => {
    for (const owner of ['a', 'b']) {
      expect((await api.readFile(resourceKey('file', owner, '/repo'), 'notes.txt')).content).toBe(
        owner
      )
      await api.fleetResolve(resourceKey('request', owner, 'same'), {
        type: 'permission',
        optionId: 'allow'
      })
    }
    expect(mocks.calls.filter((c) => c.method === 'resolve')).toEqual(
      ['a', 'b'].map((owner) => ({
        owner,
        method: 'resolve',
        args: [{ requestId: 'same', response: { type: 'permission', optionId: 'allow' } }]
      }))
    )
    await expect(
      api.readFile(resourceKey('file', 'a', '/repo'), resourceKey('file', 'b', '/repo/notes.txt'))
    ).rejects.toThrow(/different server owners/)
  })
  it('rejects an intentionally disconnected owner without any local history fallback', async () => {
    await api.fleetDisconnect('a')
    await expect(api.sessionsHistory(resourceKey('session', 'a', 'same'))).rejects.toThrow(
      /not connected/
    )
    expect(
      mocks.invoke.mock.calls.filter(([channel]) => channel === 'sessions:history')
    ).toHaveLength(0)
    expect(await api.sessionsHistory(resourceKey('session', 'b', 'same'))).toMatchObject({
      owner: 'b'
    })
  })
  it('keeps remote filesystem sources off the Mac upload path', async () => {
    await api.sessionsFiles.prepare(resourceKey('session', 'a', 'same'), {
      path: resourceKey('file', 'a', '/repo/picture.png')
    })
    expect(mocks.calls.find((c) => c.method === 'prepare')?.args).toEqual([
      { sessionId: 'same', source: { kind: 'file', root: '/', path: '/repo/picture.png' } }
    ])
    expect(
      mocks.invoke.mock.calls.filter(([channel]) => channel === 'sessions:files')
    ).toHaveLength(0)
    await expect(
      api.sessionsFiles.prepare(resourceKey('session', 'b', 'same'), {
        path: resourceKey('file', 'a', '/repo/picture.png')
      })
    ).rejects.toThrow(/another server/)
  })
  it('refuses a remote attachment source for a local session before calling Mac IPC', async () => {
    await expect(
      api.sessionsFiles.prepare('local-session', {
        path: resourceKey('file', 'a', '/repo/picture.png')
      })
    ).rejects.toThrow(/another server/)
    expect(
      mocks.invoke.mock.calls.filter(([channel]) => channel === 'sessions:files')
    ).toHaveLength(0)
  })
})

it('treats focus on a remote file as no local plugin session context', async () => {
  await api.pluginsContext(resourceKey('file', 'a', '/repo/notes.txt'))
  expect(mocks.invoke.mock.calls.filter(([channel]) => channel === 'plugins:context')).toHaveLength(
    0
  )
})

describe('server workspaces', () => {
  it('reads each server registry with ids wrapped to their owner', async () => {
    const heard: Array<{ serverId: string }> = []
    api.onFleetWorkspaces((update) => heard.push(update))
    expect(await api.fleetWorkspaces('a')).toEqual([
      {
        id: resourceKey('workspace', 'a', 'ws-a'),
        name: 'Repo',
        rootDir: '/srv/repo',
        profileFile: null,
        createdAt: 1
      }
    ])
    expect((await api.fleetWorkspaces('b')).map((w) => w.id)).toEqual([
      resourceKey('workspace', 'b', 'ws-a')
    ])
    // Read at each connect, and at each explicit read.
    expect(new Set(heard.map((h) => h.serverId))).toEqual(new Set(['a', 'b']))
  })

  it('adds a folder checked on its own server and writes only that registry', async () => {
    const heard: Array<{ serverId: string; workspaces: Array<{ id: string }> }> = []
    api.onFleetWorkspaces((update) => heard.push(update))
    const added = await api.fleetAddWorkspace('a', { rootDir: '/srv/other/' })
    expect(added).toMatchObject({ name: 'Other', rootDir: '/srv/other', profileFile: null })
    expect(added.id.startsWith(resourceKey('workspace', 'a', 'x').slice(0, -1))).toBe(true)
    expect(mocks.calls.filter((c) => c.method === 'stat')).toEqual([
      { owner: 'a', method: 'stat', args: [{ root: '/', path: '/srv/other' }] }
    ])
    const writes = mocks.calls.filter((c) => c.method === 'update-registry')
    expect(writes.map((w) => w.owner)).toEqual(['a'])
    const written = writes[0].args[0] as Array<{ id: string; rootDir: string }>
    expect(written.map((w) => w.rootDir)).toEqual(['/srv/repo', '/srv/other'])
    expect(written.every((w) => !w.id.startsWith('clave-owner:'))).toBe(true)
    expect(heard.at(-1)?.serverId).toBe('a')
    expect(heard.at(-1)?.workspaces.map((w) => w.id)).toContain(added.id)
  })

  it('refuses a file, a relative path and a folder overlapping a server workspace', async () => {
    await expect(api.fleetAddWorkspace('a', { rootDir: '/srv/notes.txt' })).rejects.toThrow(
      'not a folder'
    )
    await expect(api.fleetAddWorkspace('a', { rootDir: 'srv/x' })).rejects.toThrow('absolute')
    await expect(api.fleetAddWorkspace('a', { rootDir: '/srv/repo/sub' })).rejects.toThrow(
      'overlaps'
    )
    await expect(api.fleetAddWorkspace('a', { rootDir: '/srv' })).rejects.toThrow('overlaps')
    expect(mocks.calls.filter((c) => c.method === 'update-registry')).toEqual([])
  })

  it('removes a workspace from its owner only', async () => {
    await api.fleetRemoveWorkspace(resourceKey('workspace', 'b', 'ws-a'))
    const writes = mocks.calls.filter((c) => c.method === 'update-registry')
    expect(writes).toEqual([{ owner: 'b', method: 'update-registry', args: [[]] }])
    expect(mocks.registries.get('a')).toHaveLength(1)
    await expect(api.fleetRemoveWorkspace('local-workspace')).rejects.toThrow(
      'Not a server workspace'
    )
  })

  it('keeps an addition another Mac made between this read and this write', async () => {
    mocks.interleave = (owner) => {
      // Mac B adds its own workspace on the same server meanwhile.
      mocks.registries.set(owner, [
        ...(mocks.registries.get(owner) ?? []),
        { id: 'from-b', name: 'B', rootDir: '/srv/b', profileFile: null, createdAt: 9 }
      ])
      mocks.revisions.set(owner, (mocks.revisions.get(owner) ?? 0) + 1)
    }
    await api.fleetAddWorkspace('a', { rootDir: '/srv/mine' })
    expect(mocks.registries.get('a')!.map((w) => w.rootDir)).toEqual([
      '/srv/repo',
      '/srv/b',
      '/srv/mine'
    ])
    expect(mocks.calls.filter((c) => c.method === 'update-registry')).toHaveLength(2)
  })

  const push = (owner: string, rootDir: string, revision: number, instance: string): void =>
    mocks.events.get(owner)!({
      event: {
        _tag: 'workspaces.state_changed',
        workspaces: [{ id: rootDir, name: rootDir, rootDir, profileFile: null, createdAt: 3 }],
        pins: [],
        origin: null,
        revision,
        instance
      }
    })
  const inFlight = async (count: number): Promise<void> => {
    // At least `count`: the reads made at connect may still be in flight too.
    for (let i = 0; i < 50 && mocks.held.length < count; i++) await vi.advanceTimersByTimeAsync(1)
    expect(mocks.held.length).toBeGreaterThanOrEqual(count)
  }
  const release = async (): Promise<void> => {
    for (const held of mocks.held.splice(0)) held.release()
    await vi.advanceTimersByTimeAsync(0)
  }

  it('never rolls a newer pushed list back with an older read', async () => {
    await api.fleetWorkspaces('a')
    const heard: Array<Array<{ rootDir: string }>> = []
    api.onFleetWorkspaces((update) => heard.push(update.workspaces))
    mocks.hold = { instance: 'a', revision: 0 }
    const slow = api.fleetWorkspaces('a')
    await inFlight(1)
    mocks.hold = null
    push('a', '/new', 7, 'a')
    await release()
    await slow
    // Same instance, and an older revision even when answered before the push.
    push('a', '/older', 3, 'a')
    expect(heard.map((list) => list.map((w) => w.rootDir))).toEqual([['/new']])
  })

  it('drops a late answer from the instance a server was restarted out of', async () => {
    await api.fleetWorkspaces('a')
    const heard: Array<Array<{ rootDir: string }>> = []
    api.onFleetWorkspaces((update) => heard.push(update.workspaces))
    mocks.hold = { instance: 'a', revision: 50 }
    const slow = api.fleetWorkspaces('a')
    await inFlight(1)
    mocks.hold = null
    push('a', '/restarted', 1, 'a-restarted')
    await release()
    await slow
    push('a', '/later', 2, 'a-restarted')
    expect(heard.map((list) => list.map((w) => w.rootDir))).toEqual([['/restarted'], ['/later']])
  })

  it('keeps the restarted instance when old reads land after its first push', async () => {
    // Nothing published yet for owner b in this test's own listener: two reads
    // to the old instance are held, the restarted instance pushes, they land.
    const heard: Array<Array<{ rootDir: string }>> = []
    api.onFleetWorkspaces((update) => update.serverId === 'b' && heard.push(update.workspaces))
    mocks.hold = { instance: 'b', revision: 40 }
    const first = api.fleetWorkspaces('b')
    const second = api.fleetWorkspaces('b')
    await inFlight(2)
    mocks.hold = null
    push('b', '/restarted', 0, 'b-restarted')
    await release()
    await Promise.all([first, second])
    push('b', '/after', 1, 'b-restarted')
    expect(heard.map((list) => list.map((w) => w.rootDir))).toEqual([['/restarted'], ['/after']])
  })

  it('takes a newer revision of the same instance from a read sent earlier', async () => {
    await api.fleetWorkspaces('a')
    const heard: Array<Array<{ rootDir: string }>> = []
    api.onFleetWorkspaces((update) => heard.push(update.workspaces))
    const at = (rootDir: string): Array<Record<string, unknown>> => [
      { id: rootDir, name: rootDir, rootDir, profileFile: null, createdAt: 1 }
    ]
    // Read A goes out first but the server answers it after a change; read B,
    // sent later, is answered before that change. The change's push is late.
    mocks.hold = { instance: 'a', revision: 4, workspaces: at('/after-change') }
    const a = api.fleetWorkspaces('a')
    await inFlight(1)
    mocks.hold = { instance: 'a', revision: 3, workspaces: at('/before-change') }
    const b = api.fleetWorkspaces('a')
    await inFlight(2)
    mocks.hold = null
    const [first, second] = mocks.held.splice(0)
    second.release()
    await vi.advanceTimersByTimeAsync(0)
    first.release()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all([a, b])
    expect(heard.map((list) => list.map((w) => w.rootDir))).toEqual([
      ['/before-change'],
      ['/after-change']
    ])
    // The late push of that same change publishes nothing new.
    push('a', '/after-change', 4, 'a')
    expect(heard).toHaveLength(2)
  })

  it('drops a write answer when a newer push arrived while it was in flight', async () => {
    await api.fleetWorkspaces('a')
    const heard: Array<Array<{ rootDir: string }>> = []
    api.onFleetWorkspaces((update) => heard.push(update.workspaces))
    // The server restarts while the write is out; its new instance pushes
    // before the old write's answer comes back.
    mocks.interleave = () => push('a', '/restarted', 0, 'a-restarted')
    await api.fleetAddWorkspace('a', { rootDir: '/srv/mine' })
    expect(heard.map((list) => list.map((w) => w.rootDir))).toEqual([['/restarted']])
  })

  it('takes the read sent last when two reads answer out of order', async () => {
    await api.fleetWorkspaces('a')
    const heard: Array<Array<{ rootDir: string }>> = []
    api.onFleetWorkspaces((update) => heard.push(update.workspaces))
    mocks.hold = { instance: 'a', revision: 1 }
    const older = api.fleetWorkspaces('a')
    await inFlight(1)
    mocks.registries.set('a', [
      { id: 'n', name: 'N', rootDir: '/new', profileFile: null, createdAt: 4 }
    ])
    mocks.hold = { instance: 'a-restarted', revision: 0 }
    const newer = api.fleetWorkspaces('a')
    await inFlight(2)
    mocks.hold = null
    const [first, second] = mocks.held.splice(0)
    first.release()
    await vi.advanceTimersByTimeAsync(0)
    second.release()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all([older, newer])
    expect(heard.at(-1)?.map((w) => w.rootDir)).toEqual(['/new'])
    // And the other way round: the older answer, from the instance the
    // server was restarted out of and at a higher revision, landing last is
    // dropped.
    mocks.hold = { instance: 'a', revision: 99 }
    const third = api.fleetWorkspaces('a')
    await inFlight(1)
    mocks.registries.set('a', [
      { id: 'z', name: 'Z', rootDir: '/newest', profileFile: null, createdAt: 5 }
    ])
    mocks.hold = { instance: 'a-restarted', revision: 2 }
    const fourth = api.fleetWorkspaces('a')
    await inFlight(2)
    mocks.hold = null
    const [late, early] = mocks.held.splice(0)
    early.release()
    await vi.advanceTimersByTimeAsync(0)
    late.release()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all([third, fourth])
    expect(heard.at(-1)?.map((w) => w.rootDir)).toEqual(['/newest'])
  })

  it('takes a list from a restarted server whatever its revision', async () => {
    mocks.revisions.set('a', 9)
    await api.fleetWorkspaces('a')
    const heard: unknown[] = []
    api.onFleetWorkspaces((update) => heard.push(update))
    mocks.events.get('a')!({
      event: {
        _tag: 'workspaces.state_changed',
        workspaces: [],
        pins: [],
        origin: null,
        revision: 1,
        instance: 'a-restarted'
      }
    })
    expect(heard).toHaveLength(1)
  })

  it('relays a server registry change with the ids of that server', async () => {
    await api.fleetWorkspaces('a')
    const heard: Array<{ serverId: string; workspaces: Array<{ id: string }> }> = []
    api.onFleetWorkspaces((update) => heard.push(update))
    mocks.events.get('a')!({
      event: {
        _tag: 'workspaces.state_changed',
        workspaces: [{ id: 'new', name: 'New', rootDir: '/n', profileFile: null, createdAt: 3 }],
        pins: [],
        origin: null,
        revision: 2,
        instance: 'a'
      }
    })
    expect(heard).toEqual([
      {
        serverId: 'a',
        workspaces: [
          {
            id: resourceKey('workspace', 'a', 'new'),
            name: 'New',
            rootDir: '/n',
            profileFile: null,
            createdAt: 3
          }
        ]
      }
    ])
  })
})

// Round 6 of verification (B6-F1, B6-F2): the verifier's own reproductions, kept as regression tests.

describe('verifier request counter after accepting a higher revision', () => {
  it('does not reopen an intermediate retired-instance reply after an earlier current reply', async () => {
    await api.fleetWorkspaces('a')
    const seen: string[][] = []
    api.onFleetWorkspaces((u) => {
      if (u.serverId === 'a') seen.push(u.workspaces.map((w) => w.rootDir))
    })
    const row = (rootDir: string): Array<Record<string, unknown>> => [
      { id: rootDir, name: rootDir, rootDir, profileFile: null, createdAt: 2 }
    ]
    // A was sent first but reaches the new process last; B overtook it and
    // read the retired process; C reads the new process before A does.
    mocks.hold = { instance: 'a-new', revision: 2, workspaces: row('/current-newer') }
    const a = api.fleetWorkspaces('a')
    for (let n = 0; n < 50 && mocks.held.length < 1; n++) await vi.advanceTimersByTimeAsync(1)
    mocks.hold = { instance: 'a', revision: 50, workspaces: row('/retired') }
    const b = api.fleetWorkspaces('a')
    for (let n = 0; n < 50 && mocks.held.length < 2; n++) await vi.advanceTimersByTimeAsync(1)
    mocks.hold = { instance: 'a-new', revision: 1, workspaces: row('/current') }
    const c = api.fleetWorkspaces('a')
    for (let n = 0; n < 50 && mocks.held.length < 3; n++) await vi.advanceTimersByTimeAsync(1)
    expect(mocks.held).toHaveLength(3)
    mocks.held[2].release()
    await c
    mocks.held[0].release()
    await a
    expect(seen.at(-1)).toEqual(['/current-newer'])
    mocks.held[1].release()
    await b
    expect(seen.at(-1)).toEqual(['/current-newer'])
  })
})

describe('verifier equal live push after an HTTP answer', () => {
  it('keeps the live instance when its equal push precedes a retired reply', async () => {
    await api.fleetWorkspaces('a')
    const seen: string[][] = []
    api.onFleetWorkspaces((u) => {
      if (u.serverId === 'a') seen.push(u.workspaces.map((w) => w.rootDir))
    })
    const row = (rootDir: string): Array<Record<string, unknown>> => [
      { id: rootDir, name: rootDir, rootDir, profileFile: null, createdAt: 2 }
    ]
    mocks.hold = { instance: 'a-new', revision: 1, workspaces: row('/current') }
    const a = api.fleetWorkspaces('a')
    for (let n = 0; n < 50 && mocks.held.length < 1; n++) await vi.advanceTimersByTimeAsync(1)
    mocks.hold = { instance: 'a', revision: 50, workspaces: row('/retired') }
    const b = api.fleetWorkspaces('a')
    for (let n = 0; n < 50 && mocks.held.length < 2; n++) await vi.advanceTimersByTimeAsync(1)
    expect(mocks.held).toHaveLength(2)
    mocks.held[0].release()
    await a
    mocks.events.get('a')!({
      event: {
        _tag: 'workspaces.state_changed',
        workspaces: row('/current'),
        pins: [],
        origin: null,
        revision: 1,
        instance: 'a-new'
      }
    })
    mocks.held[1].release()
    await b
    expect(seen.at(-1)).toEqual(['/current'])
  })
})

describe('verifier equal current answer before a retired reply', () => {
  it('keeps the live instance after a later equal-revision read confirms it', async () => {
    await api.fleetWorkspaces('a')
    const seen: string[][] = []
    api.onFleetWorkspaces((u) => {
      if (u.serverId === 'a') seen.push(u.workspaces.map((w) => w.rootDir))
    })
    const row = (rootDir: string): Array<Record<string, unknown>> => [
      { id: rootDir, name: rootDir, rootDir, profileFile: null, createdAt: 2 }
    ]
    mocks.hold = { instance: 'a-new', revision: 1, workspaces: row('/current') }
    const a = api.fleetWorkspaces('a')
    for (let n = 0; n < 50 && mocks.held.length < 1; n++) await vi.advanceTimersByTimeAsync(1)
    mocks.hold = { instance: 'a', revision: 50, workspaces: row('/retired') }
    const b = api.fleetWorkspaces('a')
    for (let n = 0; n < 50 && mocks.held.length < 2; n++) await vi.advanceTimersByTimeAsync(1)
    mocks.hold = { instance: 'a-new', revision: 1, workspaces: row('/current') }
    const c = api.fleetWorkspaces('a')
    for (let n = 0; n < 50 && mocks.held.length < 3; n++) await vi.advanceTimersByTimeAsync(1)
    expect(mocks.held).toHaveLength(3)
    mocks.held[0].release()
    await a
    mocks.held[2].release()
    await c
    expect(seen).toEqual([['/current']])
    mocks.held[1].release()
    await b
    expect(seen.at(-1)).toEqual(['/current'])
  })
})
