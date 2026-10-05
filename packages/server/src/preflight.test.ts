import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startEmbedded, type EmbeddedServer } from './embedded'
import { SessionSource } from './ports'

/**
 * The preflight is decided before the token check, for every origin (ADR
 * 0003, the round-2 verifier of lane F): a loopback page gets its answer, a
 * stranger (another site, the opaque `null` origin) is refused with no CORS
 * header, and neither is ever told "Unauthenticated" for a request that
 * carries no token by definition.
 */
describe('the preflight and the token check', () => {
  let server: EmbeddedServer
  beforeAll(async () => {
    server = await startEmbedded({ sessions: SessionSource.empty, port: 0 })
  })
  afterAll(async () => {
    await server.stop()
  })

  const preflight = (origin: string | null): Promise<Response> =>
    fetch(`${server.url}/sessions`, {
      method: 'OPTIONS',
      headers: {
        ...(origin !== null ? { origin } : {}),
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization'
      }
    })

  it('a loopback page gets its preflight answered, with the headers it asked for', async () => {
    const res = await preflight('http://localhost:5173')
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(res.headers.get('access-control-allow-headers')).toBe('authorization')
  })

  it('the opaque null origin is refused before the token check, with no CORS header', async () => {
    const res = await preflight('null')
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('access-control-allow-headers')).toBeNull()
  })

  it('a page from another site is refused the same way', async () => {
    const res = await preflight('https://evil.example')
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('no preflight is ever answered 401', async () => {
    for (const origin of ['null', 'https://evil.example', 'http://localhost.evil.com']) {
      expect((await preflight(origin)).status).not.toBe(401)
    }
  })

  it('an OPTIONS with no Origin is not a preflight: it meets the token check like any request', async () => {
    expect((await preflight(null)).status).toBe(401)
  })

  it('a request with no Origin at all (a Node client) needs only the token', async () => {
    const refused = await fetch(`${server.url}/sessions`)
    expect(refused.status).toBe(401)
    const ok = await fetch(`${server.url}/sessions`, {
      headers: { authorization: `Bearer ${server.token}` }
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual([])
  })
})
