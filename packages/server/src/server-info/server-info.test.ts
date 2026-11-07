import { afterEach, describe, expect, it } from 'vitest'
import type { ServerUpgradeRequest, ServerUpgradeStatus } from '@clave/contract/server-info'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer } from '../test-support'
import { APP_RUN_REASON, ServerInfoPort, type ServerInfoService } from './port'

/**
 * The server domain (issue #266): the version a server reports, its install
 * ref and its upgrade, behind the bearer token like every route; the version
 * an upgrade takes is checked before the port sees it; the welcome names the
 * version; every change of the upgrade goes out as an event.
 */
let server: EmbeddedServer | undefined
afterEach(async () => {
  await server?.stop()
  server = undefined
})

const call = (path: string, body?: unknown, token = server!.token): Promise<Response> =>
  fetch(`${server!.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) })
  })

/** A port the test drives: what it was asked, and a status it can change. */
function fakePort(): { port: ServerInfoService; asked: ServerUpgradeRequest[] } {
  const asked: ServerUpgradeRequest[] = []
  const listeners = new Set<(status: ServerUpgradeStatus) => void>()
  let status: ServerUpgradeStatus = { supported: true, state: 'idle' }
  const port: ServerInfoService = {
    info: () => ({ version: '3.0.0-beta.6', installRef: 'v3.0.0-beta.6', upgrade: status }),
    requestUpgrade: (request) => {
      asked.push(request)
      status = {
        supported: true,
        state: 'waiting-for-idle',
        target: request.version,
        mode: 'when-idle',
        since: 5
      }
      for (const listener of listeners) listener(status)
      return status
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return { port, asked }
}

describe('the server domain over HTTP', () => {
  it('reports the version, the install ref and the upgrade state', async () => {
    const { port } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), serverInfo: port } })
    const answer = await call('/server/info')
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({
      version: '3.0.0-beta.6',
      installRef: 'v3.0.0-beta.6',
      upgrade: { supported: true, state: 'idle' }
    })
  })

  it('passes a release version to the port and answers its status', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), serverInfo: port } })
    const answer = await call('/server/upgrade', { version: '3.0.0-beta.9', when: 'idle' })
    expect(answer.status).toBe(200)
    expect(await answer.json()).toMatchObject({ state: 'waiting-for-idle', target: '3.0.0-beta.9' })
    expect(asked).toEqual([{ version: '3.0.0-beta.9', when: 'idle' }])
  })

  it.each([
    'v3.0.0',
    'dev',
    'latest',
    '3.0.0 --repo https://example.com/x.git',
    '--force',
    'https://github.com/x/y.git',
    '../../etc'
  ])('refuses %j as InvalidUpgradeVersion, and the port never hears it', async (version) => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), serverInfo: port } })
    const answer = await call('/server/upgrade', { version, when: 'now' })
    expect(answer.status).toBe(422)
    expect(await answer.json()).toMatchObject({ _tag: 'InvalidUpgradeVersion' })
    expect(asked).toEqual([])
  })

  it('takes nothing but the version and the when from the wire', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), serverInfo: port } })
    await call('/server/upgrade', {
      version: '3.0.0',
      when: 'now',
      ref: 'dev',
      repo: 'https://example.com/fork.git',
      script: '/tmp/evil.sh'
    })
    expect(asked).toEqual([{ version: '3.0.0', when: 'now' }])
  })

  it('needs the bearer token on both routes', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), serverInfo: port } })
    expect((await call('/server/info', undefined, 'wrong')).status).toBe(401)
    expect((await call('/server/upgrade', { version: '3.0.0', when: 'now' }, 'wrong')).status).toBe(
      401
    )
    const bare = await fetch(`${server.url}/server/info`)
    expect(bare.status).toBe(401)
    expect(asked).toEqual([])
  })

  it('an app-run server reports its version and refuses to upgrade itself', async () => {
    server = await startEmbedded({
      ports: { sessions: new FakeSource(), serverInfo: ServerInfoPort.appRun('3.0.0') }
    })
    expect(await (await call('/server/info')).json()).toEqual({
      version: '3.0.0',
      installRef: null,
      upgrade: { supported: false, reason: APP_RUN_REASON, state: 'idle' }
    })
    const refused = await call('/server/upgrade', { version: '3.0.1', when: 'now' })
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({
      _tag: 'CapabilityUnavailable',
      message: APP_RUN_REASON
    })
  })

  it('a server with no port says so', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    const answer = await call('/server/info')
    expect(answer.status).toBe(422)
    expect(await answer.json()).toMatchObject({ _tag: 'CapabilityUnavailable' })
  })
})

describe('the server domain on the push channel', () => {
  const welcomed = async (): Promise<{ peer: Peer; welcome: unknown }> => {
    const peer = new Peer(server!.url.replace('http', 'ws') + '/push')
    await peer.opened
    peer.send({ _tag: 'hello', token: server!.token })
    return { peer, welcome: await peer.next() }
  }

  it('names the version in the welcome', async () => {
    const { port } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), serverInfo: port } })
    const { peer, welcome } = await welcomed()
    expect(welcome).toEqual({
      _tag: 'welcome',
      serverId: server.serverId,
      protocol: 1,
      version: '3.0.0-beta.6'
    })
    peer.ws.close()
  })

  it('sends a welcome without a version when the server knows none', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    const { peer, welcome } = await welcomed()
    expect(welcome).toEqual({ _tag: 'welcome', serverId: server.serverId, protocol: 1 })
    peer.ws.close()
  })

  it('tells every peer each change of the upgrade', async () => {
    const { port } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), serverInfo: port } })
    const { peer } = await welcomed()
    await call('/server/upgrade', { version: '3.0.0-beta.9', when: 'idle' })
    let frame = await peer.next()
    while (frame._tag !== 'event') frame = await peer.next()
    expect(frame.event).toEqual({
      _tag: 'server.upgrade_changed',
      status: {
        supported: true,
        state: 'waiting-for-idle',
        target: '3.0.0-beta.9',
        mode: 'when-idle',
        since: 5
      }
    })
    peer.ws.close()
  })
})
