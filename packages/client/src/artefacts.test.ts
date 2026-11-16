import { afterEach, describe, expect, it } from 'vitest'
import { ArtefactRefused } from '@clave/contract/artefacts'
import { CapabilityUnavailable } from '@clave/contract/errors'
import {
  ArtefactRefusal,
  startEmbedded,
  type ArtefactsService,
  type EmbeddedServer
} from '@clave/server'
import { FakeSource } from '@clave/server/test-support'
import { type ClaveApiClient, createApiClient } from './api'

/**
 * The artefacts through the typed client (PRDCT-4472): each call reaches the
 * server's port, a refusal is thrown as `ArtefactRefused` with its sentence,
 * a server that shows no artefacts as `CapabilityUnavailable`.
 */
let server: EmbeddedServer | undefined
let api: ClaveApiClient | undefined
afterEach(async () => {
  await api?.dispose()
  await server?.stop()
  api = server = undefined
})

const state = { phase: 'ready', version: '0.14.1', error: null } as const
const port = (asked: unknown[]): ArtefactsService => ({
  open: async (sessionId, path) => {
    asked.push(['open', sessionId, path])
    if (path === '/nowhere') throw new ArtefactRefusal('No such file or folder: /nowhere')
    return { sessionId, target: path, page: `${path}/index.html`, title: 'deck', openedAt: 'now' }
  },
  close: async (sessionId) => void asked.push(['close', sessionId]),
  hold: async (sessionId, holdId) => {
    asked.push(['hold', sessionId, holdId])
    return {
      holdId: holdId ?? 'h1',
      lease: 'ab'.repeat(16),
      url: 'http://127.0.0.1:4100/',
      ttlMs: 90_000
    }
  },
  release: async (sessionId, holdId) => void asked.push(['release', sessionId, holdId]),
  saveVersion: async () => ({ version: 1, created: true }),
  versions: async () => ({
    versions: [{ version: 1, createdAt: '2026-11-13T10:44:40.854Z', fileCount: 1 }]
  }),
  list: async () => [],
  slidelessState: async () => state,
  installSlideless: async () => state,
  subscribe: () => () => {}
})

describe('the artefacts of the client', () => {
  it('reaches the port with each call and answers what it answered', async () => {
    const asked: unknown[] = []
    server = await startEmbedded({ ports: { sessions: new FakeSource(), artefacts: port(asked) } })
    api = createApiClient({ url: server.url, token: server.token })
    expect((await api.artefacts.open('s1', '/work/deck')).page).toBe('/work/deck/index.html')
    expect((await api.artefacts.hold('s1')).holdId).toBe('h1')
    expect((await api.artefacts.hold('s1', 'h2')).holdId).toBe('h2')
    await api.artefacts.release('s1', 'h2')
    await api.artefacts.close('s1')
    expect(await api.artefacts.saveVersion('s1')).toEqual({ version: 1, created: true })
    expect(await api.artefacts.versions('s1')).toEqual({
      versions: [{ version: 1, createdAt: '2026-11-13T10:44:40.854Z', fileCount: 1 }]
    })
    expect(await api.artefacts.list()).toEqual([])
    expect(await api.artefacts.slidelessState()).toEqual(state)
    expect(await api.artefacts.installSlideless()).toEqual(state)
    expect(asked).toEqual([
      ['open', 's1', '/work/deck'],
      ['hold', 's1', undefined],
      ['hold', 's1', 'h2'],
      ['release', 's1', 'h2'],
      ['close', 's1']
    ])
    const refused = await api.artefacts.open('s1', '/nowhere').catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(ArtefactRefused)
    expect((refused as ArtefactRefused).message).toBe('No such file or folder: /nowhere')
  })

  it('throws CapabilityUnavailable from a server that shows no artefacts', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    api = createApiClient({ url: server.url, token: server.token })
    await expect(api.artefacts.list()).rejects.toBeInstanceOf(CapabilityUnavailable)
    await expect(api.artefacts.hold('s1')).rejects.toBeInstanceOf(CapabilityUnavailable)
  })
})
