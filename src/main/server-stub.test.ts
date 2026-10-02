import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startStubServer, type StubServer } from './server-stub'

describe('the stub server', () => {
  let server: StubServer
  beforeAll(async () => {
    server = await startStubServer({ port: 0 })
  })
  afterAll(async () => {
    await server.stop()
  })

  const auth = (): Record<string, string> => ({ authorization: `Bearer ${server.token}` })

  it('binds the loopback on a free port and prints a usable url', () => {
    const u = new URL(server.url)
    expect(u.hostname).toBe('127.0.0.1')
    expect(Number(u.port)).toBe(server.port)
    expect(server.port).toBeGreaterThan(0)
    expect(server.token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('answers the two health probes without a token', async () => {
    const live = await fetch(`${server.url}/health/live`)
    expect(live.status).toBe(200)
    expect(await live.json()).toEqual({ status: 'live' })
    const ready = await fetch(`${server.url}/health/ready`)
    expect(ready.status).toBe(200)
    expect(await ready.json()).toEqual({ ready: true, checks: [] })
  })

  it('refuses everything else without the token, or with a wrong one', async () => {
    expect((await fetch(`${server.url}/clients`)).status).toBe(401)
    const wrong = await fetch(`${server.url}/clients`, {
      headers: { authorization: `Bearer ${'0'.repeat(64)}` }
    })
    expect(wrong.status).toBe(401)
    // A token of another length must not short-circuit into a comparison error.
    const short = await fetch(`${server.url}/clients`, { headers: { authorization: 'Bearer x' } })
    expect(short.status).toBe(401)
  })

  it('registers, lists and forgets a client', async () => {
    const created = await fetch(`${server.url}/clients`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'electron', pid: 4242, version: '2.0.0' })
    })
    expect(created.status).toBe(201)
    const record = (await created.json()) as { id: string; pid: number; kind: string }
    expect(record.kind).toBe('electron')
    expect(record.pid).toBe(4242)

    const listed = (await (await fetch(`${server.url}/clients`, { headers: auth() })).json()) as {
      clients: { id: string }[]
    }
    expect(listed.clients.map((c) => c.id)).toContain(record.id)
    expect(server.clients().map((c) => c.id)).toContain(record.id)

    const gone = await fetch(`${server.url}/clients/${record.id}`, {
      method: 'DELETE',
      headers: auth()
    })
    expect(gone.status).toBe(204)
    expect(server.clients().map((c) => c.id)).not.toContain(record.id)
    const again = await fetch(`${server.url}/clients/${record.id}`, {
      method: 'DELETE',
      headers: auth()
    })
    expect(again.status).toBe(404)
  })

  it('refuses a registration without a kind or a pid', async () => {
    const res = await fetch(`${server.url}/clients`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ version: '2.0.0' })
    })
    expect(res.status).toBe(400)
    const bad = await fetch(`${server.url}/clients`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: '{not json'
    })
    expect(bad.status).toBe(400)
  })

  it('answers 404 off the known paths', async () => {
    expect((await fetch(`${server.url}/nothing`, { headers: auth() })).status).toBe(404)
  })

  it('takes the token it is given, and stops for good', async () => {
    const own = await startStubServer({ port: 0, token: 'given-token' })
    expect(own.token).toBe('given-token')
    expect(
      (await fetch(`${own.url}/clients`, { headers: { authorization: 'Bearer given-token' } }))
        .status
    ).toBe(200)
    await own.stop()
    await expect(fetch(`${own.url}/health/live`)).rejects.toThrow()
  })
})
