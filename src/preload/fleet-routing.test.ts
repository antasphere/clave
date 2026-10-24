import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from './index.d'
import { resourceKey } from '../../packages/contract/src/fleet'

const mocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
  disabled: new Set<string>(),
  calls: [] as Array<{ owner: string; method: string; args: unknown[] }>,
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
  /** The push event listeners each owner's backing holds, so a test can emit. */
  pushListeners: new Map<string, Set<(envelope: unknown) => void>>()
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
        files: {
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
          status: call('git.status', {
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
          }),
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
          watch: async (subscriberId: string, paths: string[]) => {
            mocks.calls.push({ owner, method: 'git.watch', args: [subscriberId, paths] })
            return paths
          },
          unwatch: call('git.unwatch', undefined),
          magicSync: async (paths: string[]) => {
            mocks.calls.push({ owner, method: 'git.magicSync', args: [paths] })
            return paths.map((repoPath) => ({ repoPath, actions: ['committed'], error: null }))
          }
        }
      },
      push: {
        status: 'open',
        connect: () => {},
        close: () => {},
        onStatus: () => () => {},
        onEvent: (listener: (envelope: unknown) => void) => {
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
  mocks.pushListeners.clear()
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
      { owner: 'a', method: 'git.magicSync', args: [['/repo']] }
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
    expect(progress).toEqual([{ repoPath: resourceKey('file', 'b', '/repo'), op: 'sync' }])
  })
})
