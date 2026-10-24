import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from './index.d'
import { LOCAL_SERVER_ID } from '../../packages/contract/src/fleet'
import { BUILT_IN_LAUNCH_PROFILES } from '../shared/agent-launch'

const mocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  profiles: [
    {
      id: 'mac-only',
      name: 'Mac only',
      family: 'codex',
      command: ['/opt/tools/codex-wrapper', 'codex'],
      additionalArgs: ['--profile', 'mac']
    },
    {
      id: 'chat:codex:mac-only',
      name: 'Mac only chat',
      family: 'codex',
      command: ['/opt/tools/codex-wrapper', 'codex'],
      additionalArgs: ['--profile', 'mac'],
      sourceProfileId: 'mac-only'
    }
  ],
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
          start: call('start', {
            id: 'started',
            cwd: '/repo',
            folderName: 'repo',
            alive: true,
            claudeSessionId: null,
            piSessionId: null
          }),
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
    if (channel === 'launch-profiles:list')
      return {
        version: 1,
        customProfiles: mocks.profiles,
        globalDefaults: {},
        workspaceOverrides: {}
      }
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

const started = (): { options?: Parameters<ElectronAPI['spawnSession']>[1] } =>
  mocks.calls.find((c) => c.method === 'start')?.args[0] as {
    options?: Parameters<ElectronAPI['spawnSession']>[1]
  }

describe('the Mac carries its launch profiles to a server', () => {
  it.each([0, 1])('carries custom profile %i, including the chat variant source', async (index) => {
    const profile = mocks.profiles[index]
    await api.fleetStart('a', '/repo', { codexMode: true, launchProfileId: profile.id })
    expect(started().options?.launchProfile).toEqual(profile)
    expect(started().options?.launchProfileId).toBe(profile.id)
  })

  it('carries a built-in definition without its builtIn marker', async () => {
    await api.fleetStart('a', '/repo', { codexMode: true, launchProfileId: 'builtin-codex' })
    const profile = { ...BUILT_IN_LAUNCH_PROFILES.find((p) => p.id === 'builtin-codex')! }
    delete profile.builtIn
    expect(started().options?.launchProfile).toEqual(profile)
    expect(started().options?.launchProfile?.command).toEqual(['codex'])
  })

  it('passes an unknown server profile id through without a definition', async () => {
    await api.fleetStart('a', '/repo', { codexMode: true, launchProfileId: 'server-only' })
    expect(started().options?.launchProfileId).toBe('server-only')
    expect(started().options).not.toHaveProperty('launchProfile')
  })

  it('carries no profile when no id was selected', async () => {
    await api.fleetStart('a', '/repo', { codexMode: true })
    expect(started().options).not.toHaveProperty('launchProfile')
  })

  it('leaves an already carried profile intact', async () => {
    const profile = { ...mocks.profiles[0], family: 'codex' as const }
    await api.fleetStart('a', '/repo', {
      codexMode: true,
      launchProfileId: profile.id,
      launchProfile: profile
    })
    expect(started().options?.launchProfile).toEqual(profile)
    expect(
      mocks.invoke.mock.calls.filter(([channel]) => channel === 'launch-profiles:list')
    ).toHaveLength(0)
  })

  it('keeps a local start on IPC without adding a definition', async () => {
    const options = { codexMode: true, launchProfileId: 'mac-only' }
    await api.fleetStart(LOCAL_SERVER_ID, '/repo', options)
    expect(mocks.invoke).toHaveBeenCalledWith('pty:spawn', '/repo', options)
    expect(mocks.calls.filter((c) => c.method === 'start')).toHaveLength(0)
    expect(
      mocks.invoke.mock.calls.filter(([channel]) => channel === 'launch-profiles:list')
    ).toHaveLength(0)
  })

  it.each([
    { workspaceId: undefined, windowWorkspaceId: 'window-workspace' },
    { workspaceId: 'selected-workspace', windowWorkspaceId: 'window-workspace' },
    { workspaceId: undefined, windowWorkspaceId: undefined }
  ])(
    'drops a carried definition on a local attached start with %j',
    async ({ workspaceId, windowWorkspaceId }) => {
      const invoke = mocks.invoke.getMockImplementation()!
      mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
        if (channel === 'server:endpoint')
          return { url: 'http://local-server', token: 'test-only', mode: 'attached' }
        if (channel === 'window:identity')
          return { windowKey: 'local-window', workspaceId: windowWorkspaceId }
        return invoke(channel, ...args)
      })
      const profile = { ...mocks.profiles[0], family: 'codex' as const }
      const options = {
        codexMode: true,
        launchProfileId: profile.id,
        launchProfile: profile,
        workspaceId
      }
      await api.fleetStart(LOCAL_SERVER_ID, '/repo', options)
      expect(started().options).not.toHaveProperty('launchProfile')
      expect(started().options?.launchProfileId).toBe(profile.id)
      expect(started().options?.workspaceId).toBe(workspaceId ?? windowWorkspaceId)
      expect(options.launchProfile).toEqual(profile)
      expect(mocks.invoke.mock.calls.filter(([channel]) => channel === 'pty:spawn')).toHaveLength(0)
    }
  )
})
