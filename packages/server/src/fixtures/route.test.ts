import { afterEach, describe, expect, it } from 'vitest'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, aSession } from '../test-support'
import { FIXTURE_PATH } from './route'

let server: EmbeddedServer | null = null
afterEach(async () => {
  await server?.stop()
  server = null
  delete (globalThis as { __fixtureProbe?: unknown }).__fixtureProbe
})

const start = async (testFixtures: boolean): Promise<EmbeddedServer> => {
  server = await startEmbedded({
    ports: { sessions: new FakeSource(aSession('s1')) },
    ...(testFixtures && { testFixtures })
  })
  return server
}
const evaluate = (
  url: string,
  token: string | null,
  body: unknown,
  method = 'POST'
): Promise<Response> =>
  fetch(`${url}${FIXTURE_PATH}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json'
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined
  })

describe('the fixture route exists in test mode only', () => {
  it('is not there at all on a server started without test fixtures', async () => {
    const { url, token } = await start(false)
    const response = await evaluate(url, token, { source: '() => 1' })
    expect(response.status).toBe(404)
    // The default is off: an entry that says nothing gets no route.
    const silent = await startEmbedded({ ports: { sessions: new FakeSource() } })
    try {
      expect((await evaluate(silent.url, silent.token, { source: '() => 1' })).status).toBe(404)
    } finally {
      await silent.stop()
    }
  })
  it('sits behind the token like every other route', async () => {
    const { url, token } = await start(true)
    expect((await evaluate(url, null, { source: '() => 1' })).status).toBe(401)
    expect((await evaluate(url, 'nope', { source: '() => 1' })).status).toBe(401)
    expect((await evaluate(url, token, { source: '() => 1' })).status).toBe(200)
  })
  it('binds the loopback only', async () => {
    const { url } = await start(true)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })
})

describe('what the route runs', () => {
  it('runs the function source in this process with the argument and answers its awaited value', async () => {
    const { url, token } = await start(true)
    const response = await evaluate(url, token, {
      source: 'async (arg) => { globalThis.__fixtureProbe = arg.n * 2; return [arg.n, "x"] }',
      arg: { n: 21 }
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, value: [21, 'x'] })
    expect((globalThis as { __fixtureProbe?: unknown }).__fixtureProbe).toBe(42)
    // State left on globalThis by one call is there for the next, as a spec
    // that records writes on one call and reads them back on another needs.
    const again = await evaluate(url, token, { source: '() => globalThis.__fixtureProbe' })
    expect(await again.json()).toEqual({ ok: true, value: 42 })
    const nothing = await evaluate(url, token, { source: '() => undefined' })
    expect(await nothing.json()).toEqual({ ok: true, value: null })
  })
  it('answers what the function threw, by message, and refuses a body that is not a function', async () => {
    const { url, token } = await start(true)
    const thrown = await evaluate(url, token, { source: '() => { throw new Error("boom") }' })
    expect(thrown.status).toBe(200)
    expect(await thrown.json()).toMatchObject({ ok: false, error: expect.stringContaining('boom') })
    const notFn = await evaluate(url, token, { source: '42' })
    expect(await notFn.json()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not a function/)
    })
    expect((await evaluate(url, token, { nope: true })).status).toBe(400)
    expect((await evaluate(url, token, null, 'GET')).status).toBe(405)
  })
})
