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
  events: new Map<string, (value: unknown) => void>(),
  /** The push event listeners each owner's backing holds, so a test can emit. */
  pushListeners: new Map<string, Set<(envelope: unknown) => void>>(),
  /** When set, a server batch waits for it before answering: the test emits
   *  progress while the batch is in flight. */
  holdBatch: null as Promise<void> | null,
  /** When set, owner a's watch waits for it before answering. */
  holdWatchA: null as Promise<void> | null,
  /** The push status listeners each owner's backing holds, so a test can reopen. */
  pushStatusListeners: new Map<string, Set<(state: string, detail: unknown) => void>>(),
  /** A third owner, listed only when a test asks for it. */
  withC: false
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
    const owner = endpoint.url.includes('owner-a')
      ? 'a'
      : endpoint.url.includes('owner-c')
        ? 'c'
        : 'b'
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
        requests: { watch: () => () => {}, resolve: call('resolve', { accepted: true }) },
        // ── Wave wcs1023, lane C: the git domain, every path a server path ──
        git: {
          status: async (cwd: string) => {
            mocks.calls.push({ owner, method: 'git.status', args: [cwd] })
            if (cwd === '/plain')
              return {
                isRepo: false,
                branch: '',
                ahead: 0,
                behind: 0,
                hasUpstream: false,
                files: [],
                repoRoot: ''
              }
            return {
              isRepo: true,
              branch: 'main',
              ahead: 0,
              behind: 0,
              hasUpstream: true,
              files: [],
              repoRoot: '/repo',
              worktree: {
                of: '/main',
                base: null,
                baseLabel: '',
                ahead: 0,
                behind: 0,
                merged: false,
                createdAt: null,
                lastCommit: null
              }
            }
          },
          statusBatch: async (paths: string[]) => {
            mocks.calls.push({ owner, method: 'git.statusBatch', args: [paths] })
            return paths.map((path) => ({
              path,
              status: {
                isRepo: true,
                branch: 'main',
                ahead: 0,
                behind: 0,
                hasUpstream: true,
                files: [],
                repoRoot: path
              }
            }))
          },
          discover: call('git.discover', {
            repos: [{ name: 'nested', path: '/repo/nested' }],
            truncated: false
          }),
          stage: call('git.stage', undefined),
          commit: call('git.commit', { hash: 'abc', branch: 'main' }),
          watch: async (subscriberId: string, paths: string[], revision?: number) => {
            // One-shot: the first watch of owner a waits, the next ones answer.
            const hold = owner === 'a' ? mocks.holdWatchA : null
            if (hold) {
              mocks.holdWatchA = null
              await hold
            }
            mocks.calls.push({ owner, method: 'git.watch', args: [subscriberId, paths, revision] })
            return paths
          },
          unwatch: async (subscriberId: string, revision?: number) => {
            mocks.calls.push({ owner, method: 'git.unwatch', args: [subscriberId, revision] })
          },
          magicSync: async (paths: string[], batchId?: string) => {
            mocks.calls.push({ owner, method: 'git.magicSync', args: [paths, batchId] })
            if (mocks.holdBatch) await mocks.holdBatch
            return paths.map((repoPath) => ({ repoPath, actions: ['committed'], error: null }))
          }
        }
      },
      push: {
        status: 'open',
        connect: () => {},
        close: () => {},
        onStatus: (listener: (state: string, detail: unknown) => void) => {
          const set = mocks.pushStatusListeners.get(owner) ?? new Set()
          set.add(listener)
          mocks.pushStatusListeners.set(owner, set)
          return () => {
            set.delete(listener)
          }
        },
        onEvent: (listener: (envelope: unknown) => void) => {
          // Lane B's tests push through the one callback per owner; lane C's
          // through the set, so both lanes' emitters reach the fleet client.
          mocks.events.set(owner, listener)
          const set = mocks.pushListeners.get(owner) ?? new Set()
          set.add(listener)
          mocks.pushListeners.set(owner, set)
          return () => {
            set.delete(listener)
          }
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
  mocks.pushListeners.clear()
  mocks.pushStatusListeners.clear()
  mocks.withC = false
  mocks.holdBatch = null
  mocks.holdWatchA = null
  mocks.invoke.mockReset().mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'server:fleet:list')
      return ['a', 'b', ...(mocks.withC ? ['c'] : [])].map((id) => ({
        id,
        name: id,
        url: `http://owner-${id}`,
        enabled: !mocks.disabled.has(id)
      }))
    if (channel === 'server:fleet:disconnect') {
      mocks.disabled.add(String(args[0]))
      return null
    }
    if (channel === 'server:fleet:connect') {
      mocks.disabled.delete(String(args[0]))
      return null
    }
    if (channel === 'server:fleet:endpoint')
      return { url: `http://owner-${args[0]}`, token: 'test-only' }
    if (channel === 'sessions:history') return { owner: 'local', items: [] }
    // The Mac's own repo watcher answers the paths it was given.
    if (channel === 'git:watch-repos') return args[1]
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

// ── Wave wcs1023, lane C: the git panel on a server's checkout (#242) ──
describe('git routing by the owner of the repository key', () => {
  const emit = (owner: string, event: unknown): void => {
    for (const listener of mocks.pushListeners.get(owner) ?? [])
      listener({ id: 'e1', seq: 1, at: 1, event })
  }
  it('reads a server repository on its owner and keys every path it answers', async () => {
    const status = await api.getGitStatus(resourceKey('file', 'a', '/repo'))
    expect(mocks.calls.filter((c) => c.method === 'git.status')).toEqual([
      { owner: 'a', method: 'git.status', args: ['/repo'] }
    ])
    expect(status.repoRoot).toBe(resourceKey('file', 'a', '/repo'))
    expect(status.worktree?.of).toBe(resourceKey('file', 'a', '/main'))
    const found = await api.discoverGitRepos(resourceKey('file', 'b', '/repo'), true)
    expect(found.repos.map((r) => r.path)).toEqual([resourceKey('file', 'b', '/repo/nested')])
    expect(mocks.calls.filter((c) => c.method === 'git.discover')).toEqual([
      { owner: 'b', method: 'git.discover', args: ['/repo', true] }
    ])
    expect(
      mocks.invoke.mock.calls.filter(([channel]) => String(channel).startsWith('git:'))
    ).toEqual([])
  })
  it('answers a server folder that is no repository as it is, with nothing keyed', async () => {
    const status = await api.getGitStatus(resourceKey('file', 'a', '/plain'))
    expect(status).toMatchObject({ isRepo: false, repoRoot: '' })
    expect(status.worktree).toBeUndefined()
  })
  it('keeps a Mac repository on the Mac, a plain path with no server in it', async () => {
    await api.getGitStatus('/repo')
    await api.gitStage('/repo', ['a.ts'])
    expect(
      mocks.invoke.mock.calls.filter(([channel]) => String(channel).startsWith('git:'))
    ).toEqual([
      ['git:status', '/repo'],
      ['git:stage', '/repo', ['a.ts']]
    ])
    expect(mocks.calls.filter((c) => c.method.startsWith('git.'))).toEqual([])
  })
  it('sends a write to the owning server with the server path, never to the Mac', async () => {
    await api.gitStage(resourceKey('file', 'a', '/repo'), ['a.ts'])
    expect(await api.gitCommit(resourceKey('file', 'a', '/repo'), 'feat: x')).toEqual({
      hash: 'abc',
      branch: 'main'
    })
    expect(mocks.calls.filter((c) => c.method.startsWith('git.'))).toEqual([
      { owner: 'a', method: 'git.stage', args: ['/repo', ['a.ts']] },
      { owner: 'a', method: 'git.commit', args: ['/repo', 'feat: x'] }
    ])
    expect(
      mocks.invoke.mock.calls.filter(([channel]) => String(channel).startsWith('git:'))
    ).toEqual([])
  })
  it('runs a batch on its one owner and refuses a batch that spans two servers', async () => {
    const results = await api.gitMagicSync([resourceKey('file', 'a', '/repo')])
    expect(results).toEqual([
      { repoPath: resourceKey('file', 'a', '/repo'), actions: ['committed'], error: null }
    ])
    expect(mocks.calls.filter((c) => c.method === 'git.magicSync')).toEqual([
      { owner: 'a', method: 'git.magicSync', args: [['/repo'], expect.stringMatching(/^mac-/)] }
    ])
    await expect(
      api.gitMagicSync([resourceKey('file', 'a', '/repo'), resourceKey('file', 'b', '/repo')])
    ).rejects.toThrow(/two servers/)
    await expect(api.gitMagicSync(['/repo', resourceKey('file', 'b', '/repo')])).rejects.toThrow(
      /two servers/
    )
    expect(mocks.calls.filter((c) => c.method === 'git.magicSync')).toHaveLength(1)
    expect(mocks.invoke.mock.calls.filter(([channel]) => channel === 'git:magic-sync')).toEqual([])
  })
  it('splits a watch set between the Mac and each owner, and tells each what it watched', async () => {
    mocks.invoke.mockImplementationOnce(async (channel: string, ...args: unknown[]) =>
      channel === 'git:watch-repos' ? args[1] : null
    )
    const watched = await api.gitWatchRepos('git-status-1', [
      '/repo',
      resourceKey('file', 'a', '/repo'),
      resourceKey('file', 'b', '/other')
    ])
    expect(new Set(watched)).toEqual(
      new Set(['/repo', resourceKey('file', 'a', '/repo'), resourceKey('file', 'b', '/other')])
    )
    const remote = mocks.calls.filter((c) => c.method === 'git.watch')
    expect(remote.map((c) => c.owner).sort()).toEqual(['a', 'b'])
    for (const c of remote) expect(c.args[0]).toMatch(/^mac-[a-z0-9]+:git-status-1$/)
    expect(remote.find((c) => c.owner === 'a')?.args[1]).toEqual(['/repo'])
    expect(remote.find((c) => c.owner === 'b')?.args[1]).toEqual(['/other'])
    expect(mocks.invoke.mock.calls.filter(([channel]) => channel === 'git:watch-repos')).toEqual([
      ['git:watch-repos', 'git-status-1', ['/repo']]
    ])
    await api.gitUnwatchRepos('git-status-1')
    expect(
      mocks.calls
        .filter((c) => c.method === 'git.unwatch')
        .map((c) => c.owner)
        .sort()
    ).toEqual(['a', 'b'])
  })
  it('keys the repositories a server reports changed, and a batch’s progress, by their owner', async () => {
    // A backing's event listener exists once its owner is connected; a read
    // on each owner is what waits for that here.
    await api.getGitStatus(resourceKey('file', 'a', '/repo'))
    await api.getGitStatus(resourceKey('file', 'b', '/repo'))
    const changed: string[][] = []
    api.onGitReposChanged((repos) => changed.push(repos))
    const progress: Array<{ repoPath: string; op: string }> = []
    api.onGitBatchProgress((p) => progress.push({ repoPath: p.repoPath, op: p.op }))
    emit('a', { _tag: 'git.repos_changed', repos: ['/repo', '/other'] })
    emit('b', {
      _tag: 'git.batch_progress',
      op: 'sync',
      phase: 'pushing',
      repoPath: '/repo',
      repoName: 'repo',
      done: 1,
      total: 1
    })
    expect(changed).toEqual([
      [resourceKey('file', 'a', '/repo'), resourceKey('file', 'a', '/other')]
    ])
    expect(progress).toEqual([])
  })
  it('tells a server that comes back every live set it held, under fresh revisions', async () => {
    await api.getGitStatus(resourceKey('file', 'a', '/repo'))
    await api.getGitStatus(resourceKey('file', 'b', '/repo'))
    await api.gitWatchRepos('panel-1', [
      resourceKey('file', 'a', '/one'),
      resourceKey('file', 'b', '/two')
    ])
    await api.gitWatchRepos('panel-2', [resourceKey('file', 'a', '/three')])
    await api.gitUnwatchRepos('panel-2')
    mocks.calls.length = 0
    // Owner a's push channel reopens (a reconnection, or a daemon restarted).
    for (const listener of mocks.pushStatusListeners.get('a') ?? []) listener('open', {})
    await vi.waitFor(() =>
      expect(mocks.calls.filter((c) => c.method === 'git.watch')).toHaveLength(1)
    )
    const [again] = mocks.calls.filter((c) => c.method === 'git.watch')
    // Only the live set of owner a, under a revision above the one that installed it
    // (2: the first watch was 1); the unwatched panel sends nothing, owner b is not asked.
    expect(again.owner).toBe('a')
    expect(again.args).toEqual([expect.stringMatching(/:panel-1$/), ['/one'], 2])
    expect(mocks.calls.filter((c) => c.owner === 'b')).toEqual([])
  })
  it('tells a server that comes back about an unwatch it never heard, asked while it was unreachable', async () => {
    await api.gitWatchRepos('offline-panel', [resourceKey('file', 'a', '/repo')])
    await api.gitWatchRepos('moved-panel', [resourceKey('file', 'a', '/one')])
    await api.fleetDisconnect('a')
    // Asked while owner a is unreachable: both removals are swallowed for now.
    await api.gitUnwatchRepos('offline-panel')
    await api.gitWatchRepos('moved-panel', ['/mac-only'])
    mocks.calls.length = 0
    await api.fleetConnect('a')
    await vi.waitFor(() =>
      expect(mocks.calls.filter((c) => c.owner === 'a' && c.method === 'git.unwatch')).toHaveLength(
        2
      )
    )
    const unwatched = mocks.calls
      .filter((c) => c.owner === 'a' && c.method === 'git.unwatch')
      .map((c) => [String(c.args[0]).split(':').pop(), c.args[1]])
    // Each under a revision above its last request's (watch 1, the swallowed
    // request 2, this one 3); no live set re-sent since neither panel has one here.
    expect(unwatched.sort()).toEqual([
      ['moved-panel', 3],
      ['offline-panel', 3]
    ])
    expect(mocks.calls.filter((c) => c.owner === 'a' && c.method === 'git.watch')).toEqual([])
    // Once heard, the owner is not told again on the next reconnection.
    mocks.calls.length = 0
    for (const listener of mocks.pushStatusListeners.get('a') ?? []) listener('open', {})
    await vi.advanceTimersByTimeAsync(50)
    // (a reconnection also refreshes the owner's snapshot; only git calls count here)
    expect(mocks.calls.filter((c) => c.owner === 'a' && c.method.startsWith('git.'))).toEqual([])
  })
  it('tells an owner, at its first connection, a set asked while it was still unreachable', async () => {
    // Owner c exists but is disabled: never connected so far.
    mocks.withC = true
    mocks.disabled.add('c')
    await api.fleetList()
    expect(await api.gitWatchRepos('early-panel', [resourceKey('file', 'c', '/repo')])).toEqual([])
    expect(mocks.calls.filter((c) => c.owner === 'c')).toEqual([])
    await api.fleetConnect('c')
    await vi.waitFor(() =>
      expect(mocks.calls.filter((c) => c.owner === 'c' && c.method === 'git.watch')).toHaveLength(1)
    )
    const [sent] = mocks.calls.filter((c) => c.owner === 'c' && c.method === 'git.watch')
    expect(sent.args).toEqual([expect.stringMatching(/:early-panel$/), ['/repo'], 2])
    // Heard now: a later reopening of the same first connection sends nothing more
    // (only a RE-connection replays everything).
    mocks.calls.length = 0
    await api.gitUnwatchRepos('early-panel')
    expect(mocks.calls.filter((c) => c.owner === 'c' && c.method === 'git.unwatch')).toHaveLength(1)
  })
  it('lets the server ignore a watch answering after its subscriber was unwatched', async () => {
    await api.getGitStatus(resourceKey('file', 'a', '/repo'))
    await api.getGitStatus(resourceKey('file', 'b', '/repo'))
    let release = (): void => {}
    mocks.holdWatchA = new Promise<void>((resolve) => {
      release = resolve
    })
    const watching = api.gitWatchRepos('late', [
      resourceKey('file', 'a', '/repo'),
      resourceKey('file', 'b', '/other')
    ])
    await api.gitUnwatchRepos('late')
    release()
    expect(await watching).toEqual([])
    const remote = mocks.calls.filter((c) => c.method === 'git.watch' || c.method === 'git.unwatch')
    // Owner a's late watch reached it after the unwatch, with an OLDER revision
    // (1 against the unwatch's 2): the server ignores it, so nothing is sent to
    // take it back. Owner b was never reached by the stale loop.
    const aCalls = remote.filter((c) => c.owner === 'a')
    expect(aCalls.map((c) => [c.method, c.args.at(-1)])).toEqual([
      ['git.unwatch', 2],
      ['git.watch', 1]
    ])
    expect(remote.filter((c) => c.owner === 'b' && c.method === 'git.watch')).toEqual([])
  })
  it('stamps each request with its revision so an older watch answering late changes nothing', async () => {
    await api.getGitStatus(resourceKey('file', 'a', '/repo'))
    let release = (): void => {}
    mocks.holdWatchA = new Promise<void>((resolve) => {
      release = resolve
    })
    const older = api.gitWatchRepos('moving', [resourceKey('file', 'a', '/one')])
    const newer = await api.gitWatchRepos('moving', [resourceKey('file', 'a', '/two')])
    expect(newer).toEqual([resourceKey('file', 'a', '/two')])
    release()
    expect(await older).toEqual([])
    const aWatches = mocks.calls.filter((c) => c.owner === 'a' && c.method === 'git.watch')
    // The newer set answered first, the older late: each carries its revision,
    // so the server keeps `/two` (revision 2) and ignores `/one` (revision 1)
    // whichever reached it last. Nothing is re-sent and nothing unwatched.
    expect(aWatches.map((c) => [c.args[1], c.args[2]])).toEqual([
      [['/two'], 2],
      [['/one'], 1]
    ])
    expect(mocks.calls.filter((c) => c.method === 'git.unwatch')).toEqual([])
  })
  it('forwards a server’s batch progress only for a batch this Mac started, by its id, while it runs', async () => {
    await api.getGitStatus(resourceKey('file', 'a', '/repo'))
    const progress: Array<{ repoPath: string; done: number }> = []
    api.onGitBatchProgress((p) => progress.push({ repoPath: p.repoPath, done: p.done }))
    const tick = (owner: string, repoPath: string, done: number, batchId?: string): void =>
      emit(owner, {
        _tag: 'git.batch_progress',
        op: 'sync',
        phase: 'pushing',
        repoPath,
        repoName: 'repo',
        done,
        total: 1,
        ...(batchId !== undefined && { batchId })
      })
    let release = (): void => {}
    mocks.holdBatch = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = api.gitMagicSync([resourceKey('file', 'a', '/repo')])
    const second = api.gitMagicSync([resourceKey('file', 'a', '/repo')])
    await vi.waitFor(() =>
      expect(mocks.calls.filter((c) => c.method === 'git.magicSync')).toHaveLength(2)
    )
    const ids = mocks.calls.filter((c) => c.method === 'git.magicSync').map((c) => c.args[1])
    expect(ids[0]).not.toEqual(ids[1])
    tick('a', '/repo', 1, ids[0] as string) // this Mac's first batch
    tick('a', '/repo', 1, 'another-mac:7') // another Mac, same op, same repository
    tick('a', '/repo', 1) // an old server that stamps no id
    mocks.holdBatch = null
    release()
    await first
    await second
    tick('a', '/repo', 1, ids[1] as string) // over: a late event
    expect(progress).toEqual([{ repoPath: resourceKey('file', 'a', '/repo'), done: 1 }])
  })
  it('keeps forwarding a batch still in flight when an overlapping one has answered', async () => {
    await api.getGitStatus(resourceKey('file', 'a', '/repo'))
    const progress: string[] = []
    api.onGitBatchProgress((p) => progress.push(p.repoPath))
    let release = (): void => {}
    mocks.holdBatch = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = api.gitMagicSync([resourceKey('file', 'a', '/slow')])
    await vi.waitFor(() =>
      expect(mocks.calls.filter((c) => c.method === 'git.magicSync')).toHaveLength(1)
    )
    mocks.holdBatch = null
    await api.gitMagicSync([resourceKey('file', 'a', '/quick')])
    const [slowId] = mocks.calls.filter((c) => c.method === 'git.magicSync').map((c) => c.args[1])
    emit('a', {
      _tag: 'git.batch_progress',
      op: 'sync',
      phase: 'pushing',
      repoPath: '/slow',
      repoName: 'slow',
      done: 1,
      total: 1,
      batchId: slowId
    })
    release()
    await slow
    expect(progress).toEqual([resourceKey('file', 'a', '/slow')])
  })
})
