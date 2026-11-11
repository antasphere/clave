import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from './index.d'
import { LOCAL_SERVER_ID } from '../../packages/contract/src/fleet'

// The helpers' preference is the machine's that runs them (PRDCT-4330): a
// server's is read and written on THAT server, this Mac's over its own
// route, and neither ever lands on the other.

const helper = (owner: string): Record<string, unknown> => ({
  id: 'tab-title',
  label: `Tab titles on ${owner}`,
  enabled: true,
  model: 'haiku',
  defaultModel: 'haiku',
  account: { kind: 'session' }
})

const mocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
  calls: [] as Array<{ owner: string; method: string; args: unknown[] }>
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => mocks.exposed.set(name, value)
  },
  ipcRenderer: { invoke: mocks.invoke, send: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  webUtils: {}
}))
vi.mock('@clave/client/node', () => ({
  connectThroughNode: async (endpoint: { url: string }) => {
    const owner = endpoint.url.includes('owner-a') ? 'a' : 'b'
    return {
      api: {
        dispose: async () => {},
        settings: {
          helpers: {
            list: async () => {
              mocks.calls.push({ owner, method: 'helpers.list', args: [] })
              return [helper(owner)]
            },
            set: async (...args: unknown[]) => {
              mocks.calls.push({ owner, method: 'helpers.set', args })
              return [{ ...helper(owner), enabled: false }]
            }
          }
        },
        sidebar: {
          getLayout: async () => ({
            windowKey: 'server',
            revision: 0,
            groups: [],
            displayOrder: []
          })
        },
        sessions: { list: async () => [] },
        requests: { watch: () => () => {} }
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
  vi.resetModules()
  mocks.calls.length = 0
  mocks.invoke.mockReset().mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'server:fleet:list')
      return ['a', 'b'].map((id) => ({ id, name: id, url: `http://owner-${id}`, enabled: true }))
    if (channel === 'server:fleet:endpoint')
      return { url: `http://owner-${args[0]}`, token: 'test-only' }
    if (channel === 'helpers:list') return [helper('mac')]
    if (channel === 'helpers:set') return [{ ...helper('mac'), enabled: false }]
    return null
  })
  await import('./index')
  api = mocks.exposed.get('electronAPI') as ElectronAPI
  await api.fleetList()
})

const helperIpc = (): unknown[][] =>
  mocks.invoke.mock.calls.filter(([channel]) => String(channel).startsWith('helpers:'))

describe('the helpers of the picked machine', () => {
  it('a server’s are read and written on that server alone, never on this Mac', async () => {
    const listed = await api.fleetHelpers('b')
    expect(listed[0].label).toBe('Tab titles on b')
    const patch = { enabled: false, account: { kind: 'machine' as const } }
    const after = await api.fleetHelperSet('b', 'tab-title', patch)
    expect(after[0]).toMatchObject({ label: 'Tab titles on b', enabled: false })
    expect(mocks.calls).toEqual([
      { owner: 'b', method: 'helpers.list', args: [] },
      { owner: 'b', method: 'helpers.set', args: ['tab-title', patch] }
    ])
    expect(helperIpc()).toEqual([])
  })

  it('this Mac’s go through its own route, and reach no server', async () => {
    const listed = await api.fleetHelpers(LOCAL_SERVER_ID)
    expect(listed[0].label).toBe('Tab titles on mac')
    await api.fleetHelperSet(LOCAL_SERVER_ID, 'tab-title', { model: 'sonnet' })
    await api.helperSet('tab-title', { model: null })
    expect(helperIpc()).toEqual([
      ['helpers:list'],
      ['helpers:set', { helperId: 'tab-title', patch: { model: 'sonnet' } }],
      ['helpers:set', { helperId: 'tab-title', patch: { model: null } }]
    ])
    expect(mocks.calls).toEqual([])
  })
})
