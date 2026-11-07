import { describe, it, expect, vi } from 'vitest'
import { startEmbedded, SessionHost } from '@clave/server'
import * as http from 'http'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { startServer, readDiscovery, ServerBootError, type InProcessServer } from './server-boot'

const reservationId = 'dcaa2fb4-251c-46d3-b0a7-f3ec8adbb27f'
const reserved = (): Response =>
  new Response(JSON.stringify({ protocol: 1, reservationId, expiresInMs: 15000 }))
const confirmed = (): Response =>
  new Response(JSON.stringify({ ...identity, id: reservationId, registeredAt: 1 }))

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
      if (u.endsWith('/clients/registrations/v1/release')) {
        unregisterAttempts++
        if (unregisterAttempts === 1) throw new TypeError('fetch failed')
        return new Response(null, { status: 204 })
      }
      if (u.endsWith('/clients/registrations/v1/reserve')) return reserved()
      if (u.endsWith('/clients/registrations/v1/confirm')) return confirmed()
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
      expect(calls.filter((c) => c === '/clients/registrations/v1/release')).toHaveLength(2)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('does not retry a deregistration that timed out: the quit stays bounded by one attempt', async () => {
    const userData = mkdtempSync(path.join(tmpdir(), 'clave-server-boot-timeout-'))
    let unregisterAttempts = 0
    const fakeFetch = (async (input: string | URL | Request) => {
      const u = String(input)
      if (u.endsWith('/health/live')) return new Response('{"status":"live"}', { status: 200 })
      if (u.endsWith('/clients/registrations/v1/release')) {
        unregisterAttempts++
        // What AbortSignal.timeout makes fetch reject with.
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      }
      return u.endsWith('/reserve') ? reserved() : confirmed()
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
      await expect(handle.stop()).rejects.toThrow('not acknowledged')
      expect(unregisterAttempts).toBe(1)
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
      if (u.endsWith('/clients/registrations/v1/release')) {
        unregisterAttempts++
        return new Response('{"error":"ClientNotFound"}', { status: 422 })
      }
      return u.endsWith('/reserve') ? reserved() : confirmed()
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
      await expect(handle.stop()).rejects.toThrow('not acknowledged')
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

describe('v1 registration ownership under partial failure', () => {
  const noLocalStart = async (): Promise<never> => {
    throw new Error('Unexpected local fallback')
  }
  const isolated = (): string => mkdtempSync(path.join(tmpdir(), 'clave-registration-v1-'))
  it('reports unsupported legacy servers and never downgrades registration or starts another server', async () => {
    const dir = isolated()
    const paths: string[] = []
    let starts = 0
    try {
      await expect(
        startServer({
          userData: dir,
          identity,
          launch: { mode: 'attached', url: 'http://127.0.0.1:1', token: 'test' },
          startInProcess: async () => {
            starts++
            throw new Error('unexpected')
          },
          fetch: (async (url) => {
            paths.push(String(url))
            return new Response(null, { status: String(url).endsWith('/health/live') ? 200 : 404 })
          }) as typeof fetch
        })
      ).rejects.toThrow('upgrade the attached server')
      expect(starts).toBe(0)
      expect(paths.map((url) => new URL(url).pathname)).toEqual([
        '/health/live',
        '/clients/registrations/v1/reserve'
      ])
      expect(readDiscovery(dir)).toMatchObject({ ok: false, clientId: null, token: null })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it.each(['unfinished-body', 'mismatched-id', 'malformed-client'])(
    'rolls back real confirmed presence on %s',
    async (failure) => {
      const own = await startEmbedded({ ports: { sessions: SessionHost.none } })
      const dir = isolated()
      let committed = false
      const wrapped = (async (url, init) => {
        const response = await fetch(url, init)
        if (String(url).endsWith('/confirm')) {
          expect(response.status).toBe(200)
          committed = true
          if (failure === 'unfinished-body') return new Response(new ReadableStream())
          const body = await response.json()
          return new Response(
            JSON.stringify(failure === 'mismatched-id' ? { ...body, id: crypto.randomUUID() } : {})
          )
        }
        return response
      }) as typeof fetch
      try {
        await expect(
          startServer({
            userData: dir,
            startInProcess: noLocalStart,
            identity,
            timeoutMs: 250,
            fetch: wrapped,
            launch: { mode: 'attached', url: own.url, token: own.token }
          })
        ).rejects.toThrow()
        expect(committed).toBe(true)
        expect(
          await (
            await fetch(own.url + '/clients', { headers: { authorization: 'Bearer ' + own.token } })
          ).json()
        ).toEqual([])
        expect(readDiscovery(dir)).toMatchObject({ ok: false, clientId: null })
      } finally {
        await own.stop()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
  it('retries a lost release response without duplicating removal', async () => {
    const own = await startEmbedded({ ports: { sessions: SessionHost.none } })
    const dir = isolated()
    let releases = 0
    const wrapped = (async (url, init) => {
      const response = await fetch(url, init)
      if (String(url).endsWith('/release') && ++releases === 1) {
        expect(response.status).toBe(204)
        throw new TypeError('The applied release response was lost')
      }
      return response
    }) as typeof fetch
    try {
      const handle = await startServer({
        userData: dir,
        identity,
        startInProcess: noLocalStart,
        fetch: wrapped,
        launch: { mode: 'attached', url: own.url, token: own.token }
      })
      await handle.stop()
      expect(releases).toBe(2)
      expect(
        await (
          await fetch(own.url + '/clients', { headers: { authorization: 'Bearer ' + own.token } })
        ).json()
      ).toEqual([])
      expect((await fetch(own.url + '/health/live')).status).toBe(200)
    } finally {
      await own.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('refuses a delayed confirmation delivered after accepted rollback', async () => {
    const own = await startEmbedded({ ports: { sessions: SessionHost.none } })
    const dir = isolated()
    let forward: (() => Promise<Response>) | undefined
    let answer: ((response: Response) => void) | undefined
    const wrapped = (async (url, init) => {
      if (String(url).endsWith('/confirm')) {
        const replay = { ...init, signal: undefined }
        forward = () => fetch(url, replay)
        return new Promise<Response>((resolve) => {
          answer = resolve
        })
      }
      return fetch(url, init)
    }) as typeof fetch
    try {
      await expect(
        startServer({
          userData: dir,
          startInProcess: noLocalStart,
          identity,
          timeoutMs: 250,
          fetch: wrapped,
          launch: { mode: 'attached', url: own.url, token: own.token }
        })
      ).rejects.toThrow('TimeoutError')
      expect(forward).toBeTypeOf('function')
      const late = await forward!()
      expect(late.status).toBe(422)
      answer!(late)
      expect(
        await (
          await fetch(own.url + '/clients', { headers: { authorization: 'Bearer ' + own.token } })
        ).json()
      ).toEqual([])
    } finally {
      await own.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('releases confirmed ownership before reporting an unwritable discovery file', async () => {
    const own = await startEmbedded({ ports: { sessions: SessionHost.none } })
    const dir = isolated()
    mkdirSync(path.join(dir, 'clave-server.json.tmp'))
    try {
      await expect(
        startServer({
          userData: dir,
          identity,
          startInProcess: noLocalStart,
          launch: { mode: 'attached', url: own.url, token: own.token }
        })
      ).rejects.toThrow('publishing the desktop registration failed')
      expect(
        await (
          await fetch(own.url + '/clients', { headers: { authorization: 'Bearer ' + own.token } })
        ).json()
      ).toEqual([])
    } finally {
      await own.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('includes reserve response consumption in the one handshake deadline', async () => {
    const dir = isolated()
    const paths: string[] = []
    try {
      await expect(
        startServer({
          userData: dir,
          identity,
          timeoutMs: 50,
          startInProcess: noLocalStart,
          launch: { mode: 'attached', url: 'http://127.0.0.1:1', token: 'test' },
          fetch: (async (url) => {
            paths.push(new URL(String(url)).pathname)
            return String(url).endsWith('/reserve')
              ? new Response(new ReadableStream())
              : new Response(null, { status: 200 })
          }) as typeof fetch
        })
      ).rejects.toThrow('TimeoutError')
      expect(paths).toEqual(['/health/live', '/clients/registrations/v1/reserve'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('shares one cleanup promise across simultaneous stops', async () => {
    const dir = isolated()
    let finish: ((response: Response) => void) | undefined
    let releases = 0
    const wrapped = (async (url) => {
      if (String(url).endsWith('/release')) {
        releases++
        return new Promise<Response>((resolve) => {
          finish = resolve
        })
      }
      if (String(url).endsWith('/reserve')) return reserved()
      if (String(url).endsWith('/confirm')) return confirmed()
      return new Response(null, { status: 200 })
    }) as typeof fetch
    try {
      const handle = await startServer({
        userData: dir,
        startInProcess: noLocalStart,
        identity,
        fetch: wrapped,
        launch: { mode: 'attached', url: 'http://127.0.0.1:1', token: 'test' }
      })
      const first = handle.stop()
      const second = handle.stop()
      expect(second).toBe(first)
      await Promise.resolve()
      expect(releases).toBe(1)
      finish!(new Response(null, { status: 204 }))
      await Promise.all([first, second])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('stops its owned server even when release fails, exposing the unresolved outcome', async () => {
    const dir = isolated()
    const stop = vi.fn(async () => {})
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const handle = await startServer({
        userData: dir,
        identity,
        launch: { mode: 'in-process' },
        startInProcess: async () => ({
          url: 'http://127.0.0.1:1',
          token: 'secret-test-token',
          stop
        }),
        fetch: (async (url) =>
          String(url).endsWith('/release')
            ? new Response(null, { status: 503 })
            : String(url).endsWith('/reserve')
              ? reserved()
              : String(url).endsWith('/confirm')
                ? confirmed()
                : new Response(null, { status: 200 })) as typeof fetch
      })
      await expect(handle.stop()).rejects.toThrow('not acknowledged')
      expect(stop).toHaveBeenCalledTimes(1)
      expect(logs.mock.calls.flat().join(' ')).toContain('unacknowledged')
      expect(logs.mock.calls.flat().join(' ')).not.toContain('secret-test-token')
    } finally {
      logs.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it.each([
    {},
    { protocol: 2, reservationId, expiresInMs: 15000 },
    { protocol: 1, reservationId: '', expiresInMs: 15000 }
  ])('never confirms a malformed acknowledgment %j', async (body) => {
    const dir = isolated()
    const paths: string[] = []
    try {
      await expect(
        startServer({
          userData: dir,
          startInProcess: noLocalStart,
          identity,
          launch: { mode: 'attached', url: 'http://127.0.0.1:1', token: 'test' },
          fetch: (async (url) => {
            paths.push(new URL(String(url)).pathname)
            return String(url).endsWith('/reserve')
              ? new Response(JSON.stringify(body))
              : new Response(null, { status: 200 })
          }) as typeof fetch
        })
      ).rejects.toThrow()
      expect(paths).toEqual(['/health/live', '/clients/registrations/v1/reserve'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
