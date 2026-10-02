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

  it('registers, lists and forgets a client, in the contract shape', async () => {
    const created = await fetch(`${server.url}/clients`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'shell', name: 'clave-shell 2.0.0', pid: 4242 })
    })
    expect(created.status).toBe(201)
    const record = (await created.json()) as {
      id: string
      pid: number
      kind: string
      name: string
      registeredAt: number
    }
    expect(record.kind).toBe('shell')
    expect(record.name).toBe('clave-shell 2.0.0')
    expect(record.pid).toBe(4242)
    expect(typeof record.registeredAt).toBe('number')

    // The list is a bare array, oldest first (ListClients' success schema).
    const listed = (await (await fetch(`${server.url}/clients`, { headers: auth() })).json()) as {
      id: string
    }[]
    expect(Array.isArray(listed)).toBe(true)
    expect(listed.map((c) => c.id)).toContain(record.id)
    expect(server.clients().map((c) => c.id)).toContain(record.id)

    const unregister = (id: string): Promise<Response> =>
      fetch(`${server.url}/clients/unregister`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ id })
      })
    expect((await unregister(record.id)).status).toBe(204)
    expect(server.clients().map((c) => c.id)).not.toContain(record.id)
    const again = await unregister(record.id)
    expect(again.status).toBe(404)
    expect(await again.json()).toMatchObject({ error: 'ClientNotFound', id: record.id })
  })

  it('a pid is optional, and a browser client registers without one', async () => {
    const res = await fetch(`${server.url}/clients`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'browser', name: 'a browser' })
    })
    expect(res.status).toBe(201)
    const record = (await res.json()) as { id: string; pid?: number }
    expect('pid' in record).toBe(false)
    await fetch(`${server.url}/clients/unregister`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ id: record.id })
    })
  })

  it('refuses a registration with an unknown kind, no name, or a bad pid', async () => {
    const post = (body: unknown): Promise<Response> =>
      fetch(`${server.url}/clients`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    expect((await post({ kind: 'electron', name: 'x', pid: 1 })).status).toBe(400)
    expect((await post({ kind: 'shell', pid: 1 })).status).toBe(400)
    expect((await post({ kind: 'shell', name: '', pid: 1 })).status).toBe(400)
    expect((await post({ kind: 'shell', name: 'x', pid: -1 })).status).toBe(400)
    expect((await post({ kind: 'shell', name: 'x', pid: 1.5 })).status).toBe(400)
    const res = await post({ kind: 'shell', name: 'x' })
    expect(res.status).toBe(201)
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
