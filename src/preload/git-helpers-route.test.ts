import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from './index.d'

// The git panel's two one-shots run where this Mac's helpers run (PRDCT-4330):
// on the server behind the window when there is one (the separate child or an
// attached daemon, which own the helpers' preference and the accounts), and
// in main over IPC only when there is none (in-process).

const mocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
  endpoint: null as { url: string; token: string; mode?: string } | null,
  external: false,
  server: [] as Array<{ method: string; args: unknown[] }>
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => mocks.exposed.set(name, value)
  },
  ipcRenderer: { invoke: mocks.invoke, send: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  webUtils: {}
}))
vi.mock('@clave/client/node', () => ({
  connectThroughNode: async () => ({
    api: {
      dispose: async () => {},
      git: {
        generateCommitMessage: async (...args: unknown[]) => {
          mocks.server.push({ method: 'generateCommitMessage', args })
          return 'feat: from the server'
        },
        summarizePush: async (...args: unknown[]) => {
          mocks.server.push({ method: 'summarizePush', args })
          return { title: 'From the server', description: 'd' }
        }
      }
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
  })
}))

let api: ElectronAPI
const EXTERNAL = 'server:external'
async function load(endpoint: typeof mocks.endpoint, external: boolean): Promise<void> {
  vi.resetModules()
  mocks.exposed.clear()
  mocks.server.length = 0
  mocks.endpoint = endpoint
  mocks.external = external
  mocks.invoke.mockReset().mockImplementation(async (channel: string) => {
    if (channel === 'server:endpoint') return mocks.endpoint
    if (channel === EXTERNAL) return mocks.external
    if (channel === 'server:fleet:list') return []
    if (channel === 'git:generate-commit-message') return 'feat: from main'
    if (channel === 'git:summarize-push') return { title: 'From main', description: 'd' }
    return null
  })
  await import('./index')
  api = mocks.exposed.get('electronAPI') as ElectronAPI
}
const ipcGit = (): unknown[][] =>
  mocks.invoke.mock.calls.filter(([channel]) => String(channel).startsWith('git:'))

describe("this Mac's git one-shots", () => {
  beforeEach(() => mocks.invoke.mockReset())

  it('with a server of its own behind the window, run on it and never in main', async () => {
    await load({ url: 'http://127.0.0.1:1', token: 't', mode: 'attached' }, true)
    await expect(api.gitGenerateCommitMessage('/repo')).resolves.toBe('feat: from the server')
    await expect(api.gitSummarizePush('/repo', ['a'], '1 file')).resolves.toEqual({
      title: 'From the server',
      description: 'd'
    })
    expect(mocks.server).toEqual([
      { method: 'generateCommitMessage', args: ['/repo'] },
      { method: 'summarizePush', args: ['/repo', ['a'], '1 file'] }
    ])
    expect(ipcGit()).toEqual([])
  })

  it('in-process (a server inside main, with no git service), run in main', async () => {
    await load({ url: 'http://127.0.0.1:1', token: 't', mode: 'in-process' }, false)
    await expect(api.gitGenerateCommitMessage('/repo')).resolves.toBe('feat: from main')
    await expect(api.gitSummarizePush('/repo', ['a'], '1 file')).resolves.toMatchObject({
      title: 'From main'
    })
    expect(ipcGit()).toEqual([
      ['git:generate-commit-message', '/repo'],
      ['git:summarize-push', '/repo', ['a'], '1 file']
    ])
    expect(mocks.server).toEqual([])
  })
})

describe('a server of its own that cannot be reached', () => {
  it('refuses rather than run the helper in main', async () => {
    await load(null, true)
    await expect(api.gitGenerateCommitMessage('/repo')).rejects.toThrow(/not reachable/)
    expect(ipcGit()).toEqual([])
  })
})
