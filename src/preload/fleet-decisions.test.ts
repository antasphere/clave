import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from './index.d'
import { LOCAL_SERVER_ID, sessionKey } from '../../packages/contract/src/fleet'

// The decisions (PRDCT-5179) belong to the machine that asks Jev: a server's
// switches and Jev key are read and written on THAT server, this Mac's over
// its own route, and the tabs a call names are read by the server that owns
// them, the answer keyed back to the window's own keys.

const decision = (owner: string): Record<string, unknown> => ({
  id: 'tab-project',
  label: `Tab projects on ${owner}`,
  description: 'Reads which project a tab works on.',
  enabled: true
})
const statuses = (owner: string): Record<string, unknown> => ({
  elevenLabs: { configured: false, owner },
  jev: { configured: true, setAt: 1, checkedAt: 2, lastError: null }
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
    const record =
      (method: string, answer: unknown) =>
      async (...args: unknown[]) => {
        mocks.calls.push({ owner, method, args })
        return answer
      }
    return {
      api: {
        dispose: async () => {},
        settings: {
          decisions: {
            list: record('decisions.list', [decision(owner)]),
            set: record('decisions.set', [{ ...decision(owner), enabled: false }])
          },
          integrations: {
            setJevKey: record('integrations.setJevKey', statuses(owner)),
            checkJev: record('integrations.checkJev', statuses(owner)),
            removeJevKey: record('integrations.removeJevKey', statuses(owner))
          }
        },
        decisions: {
          readTabProjects: async (ids: string[]) => {
            mocks.calls.push({ owner, method: 'decisions.readTabProjects', args: [ids] })
            return {
              tabs: ids.map((sessionId) => ({ sessionId, projects: null, reason: 'no-key' }))
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
    if (channel === 'decisions:list') return [decision('mac')]
    if (channel === 'decisions:set') return [{ ...decision('mac'), enabled: false }]
    if (String(channel).startsWith('integrations:jev-')) return statuses('mac')
    return null
  })
  await import('./index')
  api = mocks.exposed.get('electronAPI') as ElectronAPI
  await api.fleetList()
})

const localIpc = (): unknown[][] =>
  mocks.invoke.mock.calls.filter(([channel]) =>
    /^(decisions:|integrations:jev-)/.test(String(channel))
  )

describe('the decisions of the picked machine', () => {
  it('a server’s switches and Jev key are read and written on that server alone', async () => {
    expect((await api.fleetDecisions('b'))[0].label).toBe('Tab projects on b')
    await api.fleetDecisionSet('b', 'tab-project', { enabled: false })
    await api.fleetJevSetKey('b', 'ts-preload-test-key')
    await api.fleetJevCheck('b')
    await api.fleetJevRemove('b')
    expect(mocks.calls.map((c) => [c.owner, c.method, ...c.args])).toEqual([
      ['b', 'decisions.list'],
      ['b', 'decisions.set', 'tab-project', { enabled: false }],
      ['b', 'integrations.setJevKey', 'ts-preload-test-key'],
      ['b', 'integrations.checkJev'],
      ['b', 'integrations.removeJevKey']
    ])
    expect(localIpc()).toEqual([])
  })

  it('this Mac’s go through its own route, and reach no server', async () => {
    expect((await api.fleetDecisions(LOCAL_SERVER_ID))[0].label).toBe('Tab projects on mac')
    await api.fleetDecisionSet(LOCAL_SERVER_ID, 'tab-project', { enabled: false })
    await api.fleetJevSetKey(LOCAL_SERVER_ID, 'ts-preload-test-key')
    await api.fleetJevCheck(LOCAL_SERVER_ID)
    await api.fleetJevRemove(LOCAL_SERVER_ID)
    expect(localIpc()).toEqual([
      ['decisions:list'],
      ['decisions:set', { decisionId: 'tab-project', patch: { enabled: false } }],
      ['integrations:jev-set-key', 'ts-preload-test-key'],
      ['integrations:jev-check'],
      ['integrations:jev-remove']
    ])
    expect(mocks.calls).toEqual([])
  })
})

describe('reading tabs', () => {
  it('a server’s tabs are read on that server by their bare ids, and answered by their keys', async () => {
    const one = sessionKey({ serverId: 'b', sessionId: 's1' })
    const two = sessionKey({ serverId: 'b', sessionId: 's2' })
    const { tabs } = await api.readTabProjects([one, two])
    expect(mocks.calls).toEqual([
      { owner: 'b', method: 'decisions.readTabProjects', args: [['s1', 's2']] }
    ])
    expect(tabs).toEqual([
      { sessionId: one, projects: null, reason: 'no-key' },
      { sessionId: two, projects: null, reason: 'no-key' }
    ])
  })

  it('a list that mixes machines is refused in words, and nothing is asked', async () => {
    const remote = sessionKey({ serverId: 'b', sessionId: 's1' })
    await expect(api.readTabProjects(['local-tab', remote])).rejects.toThrow(
      'These tabs run on different machines'
    )
    expect(mocks.calls).toEqual([])
  })
})
