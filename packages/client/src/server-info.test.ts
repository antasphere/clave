import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { CapabilityUnavailable } from '@clave/contract/errors'
import { InvalidUpgradeVersion } from '@clave/contract/server-info'
import { ServerInfoPort, startEmbedded, type EmbeddedServer } from '@clave/server'
import { FakeSource } from '@clave/server/test-support'
import { type ClaveApiClient, createApiClient } from './api'
import { ServerUnreachable } from './errors'
import { ServerInfoMissing } from './server-info'

/**
 * The server domain through the typed client (issue #266): the info and the
 * upgrade round-trip typed, the declared failures arrive as their classes,
 * and a server older than the domain (the router's 404) is told apart from
 * one that does not answer.
 */
let server: EmbeddedServer | undefined
let old: Server | undefined
let api: ClaveApiClient | undefined
afterEach(async () => {
  await api?.dispose()
  await server?.stop()
  await new Promise((resolve) => (old ? old.close(resolve) : resolve(undefined)))
  api = server = old = undefined
})

describe('the server domain of the client', () => {
  it('reads an app-run server and hears its refusal as CapabilityUnavailable', async () => {
    server = await startEmbedded({
      ports: { sessions: new FakeSource(), serverInfo: ServerInfoPort.appRun('3.0.0-beta.9') }
    })
    api = createApiClient({ url: server.url, token: server.token })
    expect(await api.server.info()).toMatchObject({
      version: '3.0.0-beta.9',
      installRef: null,
      upgrade: { supported: false }
    })
    await expect(api.server.upgrade({ version: '3.0.1', when: 'idle' })).rejects.toBeInstanceOf(
      CapabilityUnavailable
    )
  })

  it('hears a version the server refuses as InvalidUpgradeVersion', async () => {
    server = await startEmbedded({
      ports: { sessions: new FakeSource(), serverInfo: ServerInfoPort.appRun('3.0.0') }
    })
    api = createApiClient({ url: server.url, token: server.token })
    await expect(api.server.upgrade({ version: 'dev', when: 'now' })).rejects.toBeInstanceOf(
      InvalidUpgradeVersion
    )
  })

  it('tells an older server, whose router answers 404, as ServerInfoMissing', async () => {
    // What a 3.0.0-beta.6 server answers for a route it does not have.
    old = createServer((request, response) => {
      if (request.headers.authorization !== 'Bearer t') {
        response.writeHead(401).end()
        return
      }
      response
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'NotFound', message: 'route not found', correlationId: 'c' }))
    })
    await new Promise<void>((resolve) => old!.listen(0, '127.0.0.1', resolve))
    const { port } = old.address() as { port: number }
    api = createApiClient({ url: `http://127.0.0.1:${port}`, token: 't' })
    await expect(api.server.info()).rejects.toBeInstanceOf(ServerInfoMissing)
    await expect(api.server.upgrade({ version: '3.0.0', when: 'idle' })).rejects.toBeInstanceOf(
      ServerInfoMissing
    )
  })

  it('keeps a server that does not answer apart from an older one', async () => {
    api = createApiClient({ url: 'http://127.0.0.1:9', token: 't', timeoutMs: 2_000 })
    await expect(api.server.info()).rejects.toBeInstanceOf(ServerUnreachable)
  })
})
