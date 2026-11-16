import { afterEach, describe, expect, it } from 'vitest'
import type { Artefact, ArtefactEvent, SlidelessState } from '@clave/contract/artefacts'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer } from '../test-support'
import { ArtefactRefusal, type ArtefactsService } from './port'

/**
 * The artefacts domain over HTTP (PRDCT-4472): each endpoint reaches its
 * method with its payload, behind the bearer token; the implementation's
 * refusal is `ArtefactRefused` with its sentence; a server with nothing
 * behind the port says so; the three events reach a push client.
 */
let server: EmbeddedServer | undefined
afterEach(async () => {
  await server?.stop()
  server = undefined
})

const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json'
})
const post = (path: string, body: unknown, token = server!.token): Promise<Response> =>
  fetch(`${server!.url}${path}`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body)
  })
const get = (path: string, token = server!.token): Promise<Response> =>
  fetch(`${server!.url}${path}`, { headers: headers(token) })

const artefact: Artefact = {
  sessionId: 's1',
  target: '/work/deck',
  page: '/work/deck/index.html',
  title: 'deck',
  openedAt: '2026-11-12T10:00:00.000Z'
}
const ready: SlidelessState = { phase: 'ready', version: '0.14.1', error: null, override: false }
const LEASE = '0123456789abcdef0123456789abcdef'

function fakePort(): {
  port: ArtefactsService
  asked: unknown[]
  emit: (event: ArtefactEvent) => void
} {
  const asked: unknown[] = []
  const listeners = new Set<(event: ArtefactEvent) => void>()
  const port: ArtefactsService = {
    open: async (sessionId, path) => {
      asked.push(['open', sessionId, path])
      if (path === '/nowhere') throw new ArtefactRefusal('No such file or folder: /nowhere')
      return { ...artefact, sessionId, target: path }
    },
    close: async (sessionId) => {
      asked.push(['close', sessionId])
    },
    hold: async (sessionId, holdId) => {
      asked.push(['hold', sessionId, holdId])
      if (sessionId === 'bare') throw new ArtefactRefusal('This session has no artefact open.')
      return { holdId: holdId ?? 'h1', lease: LEASE, url: 'http://127.0.0.1:4100/', ttlMs: 90_000 }
    },
    release: async (sessionId, holdId) => {
      asked.push(['release', sessionId, holdId])
    },
    saveVersion: async (sessionId) => {
      asked.push(['saveVersion', sessionId])
      if (sessionId === 'broken') throw new Error('the disk is full')
      return { version: 2, created: true }
    },
    versions: async (sessionId) => {
      asked.push(['versions', sessionId])
      return { versions: [{ version: 2, createdAt: '2026-11-13T10:58:30.951Z', fileCount: 3 }] }
    },
    list: async () => {
      asked.push(['list'])
      return [artefact]
    },
    slidelessState: async () => {
      asked.push(['slidelessState'])
      return ready
    },
    installSlideless: async () => {
      asked.push(['installSlideless'])
      return ready
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return { port, asked, emit: (event) => listeners.forEach((l) => l(event)) }
}

describe('the artefacts over HTTP', () => {
  it('reaches each method with its payload and answers its result', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), artefacts: port } })
    const opened = await post('/artefacts/open', { sessionId: 's1', path: '/work/deck' })
    expect(opened.status).toBe(200)
    expect(await opened.json()).toEqual(artefact)
    expect((await post('/artefacts/close', { sessionId: 's1' })).status).toBeLessThan(300)
    const held = await post('/artefacts/hold', { sessionId: 's1' })
    expect(await held.json()).toEqual({
      holdId: 'h1',
      lease: LEASE,
      url: 'http://127.0.0.1:4100/',
      ttlMs: 90_000
    })
    expect((await post('/artefacts/hold', { sessionId: 's1', holdId: 'h7' })).status).toBe(200)
    expect(
      (await post('/artefacts/release', { sessionId: 's1', holdId: 'h7' })).status
    ).toBeLessThan(300)
    expect(await (await post('/artefacts/save-version', { sessionId: 's1' })).json()).toEqual({
      version: 2,
      created: true
    })
    expect(await (await get('/artefacts/versions?sessionId=s1')).json()).toEqual({
      versions: [{ version: 2, createdAt: '2026-11-13T10:58:30.951Z', fileCount: 3 }]
    })
    expect(await (await get('/artefacts')).json()).toEqual([artefact])
    expect(await (await get('/artefacts/slideless')).json()).toEqual(ready)
    expect(await (await post('/artefacts/slideless/install', {})).json()).toEqual(ready)
    expect(asked).toEqual([
      ['open', 's1', '/work/deck'],
      ['close', 's1'],
      ['hold', 's1', undefined],
      ['hold', 's1', 'h7'],
      ['release', 's1', 'h7'],
      ['saveVersion', 's1'],
      ['versions', 's1'],
      ['list'],
      ['slidelessState'],
      ['installSlideless']
    ])
  })

  it('answers a refusal as ArtefactRefused with its sentence, anything else as unavailable', async () => {
    const { port } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), artefacts: port } })
    const refused = await post('/artefacts/open', { sessionId: 's1', path: '/nowhere' })
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({
      _tag: 'ArtefactRefused',
      message: 'No such file or folder: /nowhere'
    })
    const bare = await post('/artefacts/hold', { sessionId: 'bare' })
    expect(await bare.json()).toMatchObject({
      _tag: 'ArtefactRefused',
      message: 'This session has no artefact open.'
    })
    const broken = await post('/artefacts/save-version', { sessionId: 'broken' })
    expect(broken.status).toBe(422)
    expect(await broken.json()).toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'artefacts',
      message: 'the disk is full'
    })
  })

  it('refuses without the token, and says so on a server with no artefacts', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    expect((await post('/artefacts/open', { sessionId: 's1', path: '/x' }, 'wrong')).status).toBe(
      401
    )
    expect((await get('/artefacts', 'wrong')).status).toBe(401)
    const answers = [
      await post('/artefacts/open', { sessionId: 's1', path: '/x' }),
      await post('/artefacts/close', { sessionId: 's1' }),
      await post('/artefacts/hold', { sessionId: 's1' }),
      await post('/artefacts/release', { sessionId: 's1', holdId: 'h1' }),
      await post('/artefacts/save-version', { sessionId: 's1' }),
      await post('/artefacts/slideless/install', {}),
      await get('/artefacts'),
      await get('/artefacts/slideless')
    ]
    for (const answer of answers) {
      expect(answer.status).toBe(422)
      expect(await answer.json()).toMatchObject({
        _tag: 'CapabilityUnavailable',
        capability: 'artefacts',
        message: 'This server shows no artefacts.'
      })
    }
  })

  it('tells a push client each of its three events', async () => {
    const { port, emit } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), artefacts: port } })
    const peer = new Peer(server.url.replace('http', 'ws') + '/push')
    await peer.opened
    peer.send({ _tag: 'hello', token: server.token, client: 'test' })
    expect(await peer.next()).toMatchObject({ _tag: 'welcome' })
    const events: ArtefactEvent[] = [
      { _tag: 'artefact.changed', sessionId: 's1', artefact },
      { _tag: 'artefact.changed', sessionId: 's1', artefact: null },
      { _tag: 'artefact.preview_exited', sessionId: 's1' },
      { _tag: 'slideless.state_changed', state: ready }
    ]
    for (const event of events) {
      emit(event)
      expect(await peer.next()).toMatchObject({ _tag: 'event', event })
    }
    peer.ws.close()
  })
})
