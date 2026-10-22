import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from './index.d'
import { resourceKey } from '../../packages/contract/src/fleet'

const mocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
  disabled: new Set<string>(),
  calls: [] as Array<{ owner: string; method: string; args: unknown[] }>,
  listeners: new Map<string, Set<(...args: unknown[]) => void>>()
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
        requests: { watch: () => () => {}, resolve: call('resolve', { accepted: true }) }
      },
      push: {
        status: 'open',
        connect: () => {},
        close: () => {},
        onStatus: () => () => {},
        onEvent: () => () => {},
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
