import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { startEmbedded, type EmbeddedServer } from '@clave/server'
import { FakeSource, aSession } from '@clave/server/test-support'
import { SessionNotFound } from '@clave/contract/sessions'
import { type ClaveApiClient, createApiClient } from './api'
import { ServerRefused, ServerUnreachable } from './errors'

let server: EmbeddedServer
let source: FakeSource
let api: ClaveApiClient

beforeEach(async () => {
  source = new FakeSource(aSession('s1'), aSession('s2', 'w2'))
  server = await startEmbedded({ sessions: source })
  api = createApiClient({ url: server.url, token: server.token })
})
afterEach(async () => {
  await api.dispose()
  await server.stop()
})

describe('the typed request client', () => {
  it('round-trips a query and a command, typed end to end', async () => {
    expect((await api.sessions.list()).map((s) => s.id).sort()).toEqual(['s1', 's2'])
    expect((await api.sessions.list('w2')).map((s) => s.id)).toEqual(['s2'])
    expect(await api.sessions.get('s1')).toMatchObject({ id: 's1', provider: 'echo' })
    await api.sessions.write('s1', { type: 'bytes', data: new Uint8Array([104, 105]) })
    await api.sessions.write('s1', { type: 'user_message', text: 'hello' })
    expect(source.writes).toHaveLength(2)
    expect(Array.from((source.writes[0].input as { data: Uint8Array }).data)).toEqual([104, 105])
    expect(source.writes[1].input).toEqual({ type: 'user_message', text: 'hello' })
    const client = await api.clients.register({ kind: 'shell', name: 'clave-shell', pid: 7 })
    expect(client).toMatchObject({ kind: 'shell', name: 'clave-shell', pid: 7 })
    expect(await api.clients.list()).toEqual([client])
    await api.clients.unregister(client.id)
    expect(await api.clients.list()).toEqual([])
    expect(await api.health.live()).toBe(true)
  })
  it('throws the declared failure as the tagged error it is', async () => {
    const error = await api.sessions.get('ghost').catch((e) => e)
    expect(error).toBeInstanceOf(SessionNotFound)
    expect(error).toMatchObject({ _tag: 'SessionNotFound', id: 'ghost' })
  })
  it('says the server refused a wrong token', async () => {
    const wrong = createApiClient({ url: server.url, token: 'wrong' })
    const error = await wrong.sessions.list().catch((e) => e)
    expect(error).toBeInstanceOf(ServerRefused)
    expect(error).toMatchObject({ status: 401, url: server.url })
    await wrong.dispose()
  })
  it('makes one attempt and no more, so a command never runs twice behind its back', async () => {
    // A server that takes the request and never answers: the one failure the
    // framework would retry (a timeout is transient), so the attempt count is
    // what decides whether a second request goes out.
    let hits = 0
    const silent = createServer(() => {
      hits += 1
    })
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const port = (silent.address() as { port: number }).port
    const once = createApiClient({ url: `http://127.0.0.1:${port}`, token: 't', timeoutMs: 300 })
    const started = Date.now()
    await expect(once.clients.register({ kind: 'other', name: 'x' })).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(900)
    expect(hits).toBe(1)
    await once.dispose()
    silent.closeAllConnections()
    await new Promise((resolve) => silent.close(resolve))
  })
  it('says the server is unreachable, at once, when nothing listens', async () => {
    const stopped = await startEmbedded({ sessions: source })
    const url = stopped.url
    await stopped.stop()
    const gone = createApiClient({ url, token: 't', timeoutMs: 2000 })
    const started = Date.now()
    const error = await gone.sessions.list().catch((e) => e)
    expect(error).toBeInstanceOf(ServerUnreachable)
    expect(error.url).toBe(url)
    expect(Date.now() - started).toBeLessThan(1500)
    await gone.dispose()
  })
})
