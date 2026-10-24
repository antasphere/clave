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
  beforeEach(async () => {
    // Opens each server's backing, and with it the socket the lists come over.
    await api.fleetWorkspaces('a')
    await api.fleetWorkspaces('b')
  })

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
    // A read answers its caller alone: the renderer's list comes from the socket.
    expect(heard).toEqual([])
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
    // The write's answer is not published; the change it made comes as a push.
    expect(heard).toEqual([])
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
    // Round 7 (B7-F2): another spelling of the same folder overlaps it.
    await expect(api.fleetAddWorkspace('a', { rootDir: '/srv/./repo' })).rejects.toThrow('overlaps')
    await expect(api.fleetAddWorkspace('a', { rootDir: '/srv//x/../repo/' })).rejects.toThrow(
      'overlaps'
    )
    expect(mocks.calls.filter((c) => c.method === 'update-registry')).toEqual([])
  })

  it('stores and checks a folder in one spelling', async () => {
    mocks.registries.set('a', [
      { id: 'odd', name: 'Odd', rootDir: '/srv/./old/', profileFile: null, createdAt: 1 }
    ])
    await expect(api.fleetAddWorkspace('a', { rootDir: '/srv/old/sub' })).rejects.toThrow(
      'overlaps'
    )
    const added = await api.fleetAddWorkspace('a', { rootDir: '/srv//x/./y/../z/' })
    expect(added.rootDir).toBe('/srv/x/z')
    expect(mocks.calls.filter((c) => c.method === 'stat').at(-1)?.args).toEqual([
      { root: '/', path: '/srv/x/z' }
    ])
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
  const listen = (owner: string): string[][] => {
    const seen: string[][] = []
    api.onFleetWorkspaces((u) => {
      if (u.serverId === owner) seen.push(u.workspaces.map((w) => w.rootDir))
    })
    return seen
  }
  const row = (rootDir: string): Array<Record<string, unknown>> => [
    { id: rootDir, name: rootDir, rootDir, profileFile: null, createdAt: 2 }
  ]
  /** Holds `answers.length` reads, each answered by the instance and list given. */
  const holdReads = async (
    answers: Array<{ instance: string; revision: number; rootDir?: string }>
  ): Promise<Array<Promise<unknown>>> => {
    const reads: Array<Promise<unknown>> = []
    for (const answer of answers) {
      mocks.hold = {
        instance: answer.instance,
        revision: answer.revision,
        workspaces: answer.rootDir ? row(answer.rootDir) : []
      }
      reads.push(api.fleetWorkspaces('a'))
      for (let n = 0; n < 50 && mocks.held.length < reads.length; n++)
        await vi.advanceTimersByTimeAsync(1)
    }
    mocks.hold = null
    expect(mocks.held).toHaveLength(answers.length)
    return reads
  }

  it('takes each newer change of one process and drops an equal or older one', async () => {
    const seen = listen('a')
    push('a', '/welcome', 5, 'a')
    // A change that crossed the welcome list: already in it.
    push('a', '/crossed', 5, 'a')
    push('a', '/older', 4, 'a')
    push('a', '/next', 6, 'a')
    expect(seen).toEqual([['/welcome'], ['/next']])
  })

  it('takes a list from a restarted server whatever its revision', async () => {
    const seen = listen('a')
    push('a', '/before', 9, 'a')
    push('a', '/restarted', 1, 'a-restarted')
    push('a', '/after', 2, 'a-restarted')
    expect(seen).toEqual([['/before'], ['/restarted'], ['/after']])
  })

  it('publishes no read answer, whatever process answers and in whatever order', async () => {
    // The sequences of rounds 2 to 7: reads answered by the process the
    // server was restarted out of and by the new one, sent after the live
    // list came, answered in either order. Only the socket's list stays.
    const orders = [
      [0, 1],
      [1, 0]
    ]
    for (const order of orders) {
      const seen = listen('a')
      push('a', '/pushed', 2, `a-new-${order.join('')}`)
      const reads = await holdReads([
        { instance: 'a', revision: 50, rootDir: '/retired' },
        { instance: `a-new-${order.join('')}`, revision: 3, rootDir: '/answered' }
      ])
      for (const i of order) {
        mocks.held[i].release()
        await reads[i]
      }
      mocks.held.length = 0
      expect(seen).toEqual([['/pushed']])
    }
  })

  it('publishes no write answer: the change it made comes as a push', async () => {
    const seen = listen('a')
    await api.fleetAddWorkspace('a', { rootDir: '/srv/mine' })
    expect(seen).toEqual([])
    push('a', '/srv/mine', 1, 'a')
    expect(seen).toEqual([['/srv/mine']])
  })

  it('relays a server registry change with the ids of that server', async () => {
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

  // Round 7 of verification (B7-F1): the verifier's own reproductions, kept as regression tests.

  describe('verifier whole-rule retired instance', () => {
    it('does not resurrect a removed workspace from a later-sent retired reply', async () => {
      const seen = listen('a')
      // The old process's list, then the new process's socket: its registry is empty.
      push('a', '/srv/repo', 0, 'a')
      mocks.events.get('a')!({
        event: {
          _tag: 'workspaces.state_changed',
          workspaces: [],
          pins: [],
          origin: null,
          revision: 1,
          instance: 'a-new'
        }
      })
      expect(seen.at(-1)).toEqual([])
      // A read sent before the live list, and one sent after it that the
      // retired process answers last.
      const [earlier, later] = await holdReads([
        { instance: 'a-new', revision: 1 },
        { instance: 'a', revision: 0, rootDir: '/srv/repo' }
      ])
      mocks.held[0].release()
      await earlier
      expect(seen.at(-1)).toEqual([])
      mocks.held[1].release()
      await later
      expect(seen.at(-1)).toEqual([])
    })

    it('does not resurrect it on first connect either', async () => {
      const seen = listen('a')
      const [earlier, later] = await holdReads([
        { instance: 'a-new', revision: 1 },
        { instance: 'a', revision: 0, rootDir: '/srv/repo' }
      ])
      mocks.held[0].release()
      await earlier
      mocks.held[1].release()
      await later
      expect(seen).toEqual([])
      // The welcome list of the live process is what the renderer gets.
      mocks.events.get('a')!({
        event: {
          _tag: 'workspaces.state_changed',
          workspaces: [],
          pins: [],
          origin: null,
          revision: 1,
          instance: 'a-new'
        }
      })
      expect(seen).toEqual([[]])
    })
  })
})
