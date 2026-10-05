import { describe, it, expect } from 'vitest'
import * as http from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { startServer, readDiscovery, ServerBootError, type InProcessServer } from './server-boot'

const identity = { kind: 'shell' as const, name: 'clave-shell 2.0.0', pid: 777 }

/** A server that answers every request with one status. */
function answering(status: number): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = http.createServer((_req, res) => res.writeHead(status).end())
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        stop: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

describe('stop, when the pooled connection is dead', () => {
  it('retries the deregistration once on a network error, so no ghost client stays', async () => {
    const userData = mkdtempSync(path.join(tmpdir(), 'clave-server-boot-reset-'))
    const calls: string[] = []
    let unregisterAttempts = 0
    // A fetch that answers the probe and the registration, then fails the
    // first deregistration as undici does on a socket the server closed.
    const fakeFetch = (async (input: string | URL | Request) => {
      const u = String(input)
      calls.push(u.replace(/^http:\/\/[^/]+/, ''))
      if (u.endsWith('/health/live')) return new Response('{"status":"live"}', { status: 200 })
      if (u.endsWith('/clients/unregister')) {
        unregisterAttempts++
        if (unregisterAttempts === 1) throw new TypeError('fetch failed')
        return new Response(null, { status: 204 })
      }
      if (u.endsWith('/clients'))
        return new Response('{"id":"c-1"}', {
          status: 201,
          headers: { 'content-type': 'application/json' }
        })
      return new Response(null, { status: 404 })
    }) as typeof fetch
    try {
      const handle = await startServer({
        launch: { mode: 'attached', url: 'http://127.0.0.1:1', token: 't' },
        userData,
        identity,
        fetch: fakeFetch,
        startInProcess: async () => {
          throw new Error('must not be called')
        }
      })
      await handle.stop()
      expect(unregisterAttempts).toBe(2)
      expect(calls.filter((c) => c === '/clients/unregister')).toHaveLength(2)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('does not retry on a server answer, only on a network error', async () => {
    const userData = mkdtempSync(path.join(tmpdir(), 'clave-server-boot-reset2-'))
    let unregisterAttempts = 0
    const fakeFetch = (async (input: string | URL | Request) => {
      const u = String(input)
      if (u.endsWith('/health/live')) return new Response('{"status":"live"}', { status: 200 })
      if (u.endsWith('/clients/unregister')) {
        unregisterAttempts++
        return new Response('{"error":"ClientNotFound"}', { status: 422 })
      }
      return new Response('{"id":"c-1"}', { status: 201 })
    }) as typeof fetch
    try {
      const handle = await startServer({
        launch: { mode: 'attached', url: 'http://127.0.0.1:1', token: 't' },
        userData,
        identity,
        fetch: fakeFetch,
        startInProcess: async () => {
          throw new Error('must not be called')
        }
      })
      await handle.stop()
      expect(unregisterAttempts).toBe(1)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})

describe('startServer, the attach error paths', () => {
  it('a server that answers /health/live with a 503 is reported as that, not as "nothing answers"', async () => {
    const userData = mkdtempSync(path.join(tmpdir(), 'clave-server-boot-503-'))
    const sick = await answering(503)
    const starter = async (): Promise<InProcessServer> => {
      throw new Error('must not be called: the url was given')
    }
    try {
      await expect(
        startServer({
          env: { CLAVE_SERVER_URL: sick.url, CLAVE_SERVER_TOKEN: 'x' },
          userData,
          identity,
          startInProcess: starter
        })
      ).rejects.toThrow(/answered 503 on \/health\/live/)
      expect(readDiscovery(userData)).toMatchObject({ ok: false, url: sick.url })
      expect(readDiscovery(userData)?.error).toMatch(/503/)
      expect(readDiscovery(userData)?.error).not.toMatch(/nothing answers/)
    } finally {
      await sick.stop()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('in-process: a server of our own that answers 503 is stopped exactly once', async () => {
    const userData = mkdtempSync(path.join(tmpdir(), 'clave-server-boot-503-own-'))
    const sick = await answering(503)
    let stops = 0
    const starter = async (): Promise<InProcessServer> => ({
      url: sick.url,
      token: 'x',
      stop: async () => {
        stops++
      }
    })
    try {
      const err = await startServer({ env: {}, userData, identity, startInProcess: starter }).catch(
        (e) => e
      )
      expect(err).toBeInstanceOf(ServerBootError)
      expect((err as ServerBootError).mode).toBe('in-process')
      expect(stops).toBe(1)
    } finally {
      await sick.stop()
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
