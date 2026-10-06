import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { SessionHost, startEmbedded, type EmbeddedServer } from '@clave/server'
import { FakeSource, aSession } from '@clave/server/test-support'
import { SessionNotFound, SessionWriteRefused } from '@clave/contract/sessions'
import { CapabilityUnavailable } from '@clave/contract/errors'
import { type ClaveApiClient, createApiClient } from './api'
import { ServerRefused, ServerUnreachable } from './errors'

let server: EmbeddedServer
let source: FakeSource
let api: ClaveApiClient

beforeEach(async () => {
  source = new FakeSource(aSession('s1'), aSession('s2', 'w2'))
  server = await startEmbedded({ ports: { sessions: source } })
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
  it('starts and stops a session, typed end to end', async () => {
    const info = await api.sessions.start({
      cwd: '/work/app',
      windowKey: 'w1',
      options: { claudeMode: true, link: { kind: 'toolbar', key: 'k1' } }
    })
    expect(info).toEqual({
      id: 'started-1',
      cwd: '/work/app',
      folderName: 'app',
      alive: true,
      claudeSessionId: null,
      piSessionId: null
    })
    expect(source.starts).toEqual([
      {
        cwd: '/work/app',
        windowKey: 'w1',
        options: { claudeMode: true, link: { kind: 'toolbar', key: 'k1' } }
      }
    ])
    expect(await api.sessions.stop('started-1')).toBeUndefined()
    expect(source.stops).toEqual(['started-1'])
  })
  it('sets a session’s view and reads its models, commands, capabilities and history', async () => {
    expect(await api.sessions.setView('s1', 'clave.chat/chat')).toMatchObject({
      id: 's1',
      viewId: 'clave.chat/chat'
    })
    const back = await api.sessions.setView('s1', null)
    expect(back.id).toBe('s1')
    expect(back.viewId).toBeUndefined()
    expect(await api.sessions.models('s1')).toEqual(source.modelsOf)
    expect(await api.sessions.commands('s1')).toEqual(source.commandsOf)
    expect(await api.sessions.capabilities('s1')).toEqual({ images: true })
    source.historyOf = {
      items: [{ event: { type: 'state_change', state: 'working' }, at: 7 }],
      before: 2
    }
    expect(await api.sessions.history('s1', 12, 40)).toEqual(source.historyOf)
    expect(source.historyAsked).toEqual([{ id: 's1', before: 12, limit: 40 }])
    expect(typeof source.historyAsked[0].before).toBe('number')
    expect(typeof source.historyAsked[0].limit).toBe('number')
    await api.sessions.history('s1')
    expect(source.historyAsked[1]).toEqual({ id: 's1', before: undefined, limit: undefined })
  })
  it('throws a missing capability as the tagged error it is, on a server with no sessions', async () => {
    const bare = await startEmbedded({ ports: { sessions: SessionHost.none } })
    const bareApi = createApiClient({ url: bare.url, token: bare.token })
    try {
      const error = await bareApi.sessions.start({ cwd: '/work' }).catch((e) => e)
      expect(error).toBeInstanceOf(CapabilityUnavailable)
      expect(error).toMatchObject({ _tag: 'CapabilityUnavailable', capability: 'sessions' })
    } finally {
      await bareApi.dispose()
      await bare.stop()
    }
  })
  it('throws a refused view and an unknown session as their tagged errors', async () => {
    const refused = await api.sessions.setView('s1', 'nonsense').catch((e) => e)
    expect(refused).toBeInstanceOf(SessionWriteRefused)
    expect(refused).toMatchObject({ _tag: 'SessionWriteRefused', id: 's1' })
    const missing = await api.sessions.get('nope').catch((e) => e)
    expect(missing).toBeInstanceOf(SessionNotFound)
    expect(missing).toMatchObject({ _tag: 'SessionNotFound', id: 'nope' })
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
    const stopped = await startEmbedded({ ports: { sessions: source } })
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
