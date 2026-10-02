import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
