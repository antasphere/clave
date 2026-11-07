import { beforeAll, describe, expect, it, vi } from 'vitest'
import { resourceKey } from '@clave/contract/fleet'
import type { Workspace } from '../../../shared/workspace-types'

// The module reaches the stores, which read the bridge at import time.
let proposePairings: typeof import('./workspace-pairing').proposePairings
beforeAll(async () => {
  const memory = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key)
  })
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('electronAPI', {})
  ;({ proposePairings } = await import('./workspace-pairing'))
})

const ws = (id: string, rootDir: string): Workspace => ({
  id,
  name: id,
  rootDir,
  profileFile: null,
  createdAt: 1
})
const serverWs = (server: string, id: string, rootDir: string): Workspace =>
  ws(resourceKey('workspace', server, id), rootDir)
const remotes: Record<string, string | null> = {
  '/Users/me/.antasphere': 'github.com/antasphere/workspace',
  '/Users/me/other': 'github.com/acme/other',
  '/Users/me/plain': null,
  [resourceKey('file', 'studio', '/home/me/.antasphere')]: 'github.com/antasphere/workspace',
  [resourceKey('file', 'studio', '/srv/scratch')]: null,
  [resourceKey('file', 'vps', '/opt/.antasphere')]: 'github.com/antasphere/workspace'
}
const input = {
  localWorkspaces: [
    ws('mac-a', '/Users/me/.antasphere'),
    ws('mac-b', '/Users/me/other'),
    ws('mac-c', '/Users/me/plain')
  ],
  serverWorkspaces: {
    studio: [
      serverWs('studio', 'ws-1', '/home/me/.antasphere'),
      serverWs('studio', 'ws-2', '/srv/scratch')
    ],
    vps: [serverWs('vps', 'ws-9', '/opt/.antasphere')]
  },
  connected: () => true,
  remoteOf: (key: string) => remotes[key]
}

describe('proposePairings (PRDCT-4151)', () => {
  it('pairs a server workspace with the Mac workspace of the same remote, per connected server', () => {
    expect(proposePairings({ ...input, servers: {} })).toEqual([
      {
        serverId: 'studio',
        serverWorkspaceId: resourceKey('workspace', 'studio', 'ws-1'),
        localWorkspaceId: 'mac-a',
        remote: 'github.com/antasphere/workspace'
      },
      {
        serverId: 'vps',
        serverWorkspaceId: resourceKey('workspace', 'vps', 'ws-9'),
        localWorkspaceId: 'mac-a',
        remote: 'github.com/antasphere/workspace'
      }
    ])
    expect(proposePairings({ ...input, servers: {}, connected: (id) => id === 'vps' })).toHaveLength(
      1
    )
  })

  it('proposes nothing already paired, declined, or on a server turned off', () => {
    const entry = { color: '#5e6ad2', pairs: {}, declined: [] as string[] }
    expect(
      proposePairings({ ...input, servers: { studio: { ...entry, pairs: { 'ws-1': 'mac-a' } } } })
        .map((p) => p.serverId)
    ).toEqual(['vps'])
    expect(
      proposePairings({ ...input, servers: { studio: { ...entry, declined: ['ws-1'] } } }).map(
        (p) => p.serverId
      )
    ).toEqual(['vps'])
    expect(
      proposePairings({ ...input, servers: { studio: { ...entry, combine: false } } }).map(
        (p) => p.serverId
      )
    ).toEqual(['vps'])
    // Turned on by hand before any pairing: proposals come.
    expect(
      proposePairings({ ...input, servers: { studio: { ...entry, combine: true } } }).map(
        (p) => p.serverId
      )
    ).toEqual(['studio', 'vps'])
  })

  it('pairs one Mac workspace with one workspace per server, and never a root without a remote', () => {
    const twice = {
      ...input,
      serverWorkspaces: {
        studio: [
          serverWs('studio', 'ws-1', '/home/me/.antasphere'),
          serverWs('studio', 'ws-3', '/home/me/again')
        ]
      },
      remoteOf: (key: string) =>
        key === resourceKey('file', 'studio', '/home/me/again')
          ? 'github.com/antasphere/workspace'
          : remotes[key]
    }
    expect(proposePairings({ ...twice, servers: {} }).map((p) => p.serverWorkspaceId)).toEqual([
      resourceKey('workspace', 'studio', 'ws-1')
    ])
    expect(
      proposePairings({
        ...input,
        localWorkspaces: [ws('mac-c', '/Users/me/plain')],
        servers: {}
      })
    ).toEqual([])
  })
})
