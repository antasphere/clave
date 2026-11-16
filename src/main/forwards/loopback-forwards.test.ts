/**
 * The Mac's hop on its own (PRDCT-4473): a `LoopbackForwards` listener in
 * front of a STAND-IN for the server, a plain HTTP server that records what
 * it receives and drops nothing. The chain test puts the real server behind
 * the hop, and the real server drops the cookies and the page's own reports
 * too, so a rule this hop lost would not show there. Here each rule of this
 * hop is the only one between the page and what the stand-in sees.
 */
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FORWARD_ORIGIN_HEADER,
  FORWARD_PATH,
  FORWARD_REFUSED,
  FORWARD_REFUSED_HEADER,
  FORWARD_SELF_ORIGIN
} from '@clave/contract/forward'
import { ask } from '../../../packages/server/src/forward/test-target'
import { LoopbackForwards, WINDOW_HEADER, type OpenedForward } from './loopback-forwards'

/** The stand-in's bearer: the only one the stand-in may ever see. */
const TOKEN = 'the-stand-in-token'
const lease = randomBytes(16).toString('hex')

interface Seen {
  readonly url: string
  readonly headers: http.IncomingHttpHeaders
}

let standIn: http.Server
let standInUrl: string
const received: Seen[] = []
let forwards: LoopbackForwards
let opened: OpenedForward

beforeAll(async () => {
  standIn = http.createServer((req, res) => {
    received.push({ url: req.url ?? '', headers: req.headers })
    req.resume()
    const prefix = `${FORWARD_PATH}/${lease}`
    const rest = (req.url ?? '').startsWith(prefix) ? (req.url ?? '').slice(prefix.length) : null
    if (rest === null) {
      res.writeHead(404)
      res.end()
    } else if (rest === '/refused') {
      // One route answers with the server hop's own refusal mark.
      res.writeHead(404, {
        [FORWARD_REFUSED_HEADER]: FORWARD_REFUSED,
        'content-type': 'text/plain'
      })
      res.end('no such lease')
    } else {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'a=b' })
      res.end(JSON.stringify({ url: req.url, headers: req.headers }))
    }
  })
  await new Promise<void>((resolve) => standIn.listen(0, '127.0.0.1', resolve))
  standInUrl = `http://127.0.0.1:${(standIn.address() as AddressInfo).port}`
  forwards = new LoopbackForwards()
  opened = await forwards.open({
    key: `stand-in:${lease}`,
    label: 'stand-in',
    lease,
    upstream: async () => ({ url: standInUrl, token: TOKEN })
  })
})
afterAll(async () => {
  await forwards.closeAll()
  await new Promise<void>((resolve) => standIn.close(() => resolve()))
})

/** A request of a Clave window to the listener, and what the stand-in received for it. */
async function through(
  path: string,
  headers: Record<string, string> = {}
): Promise<{
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
  seen: Seen | undefined
}> {
  const before = received.length
  const answer = await ask(opened.port, path, {
    headers: { [WINDOW_HEADER]: forwards.secrets().get(opened.port)!, ...headers }
  })
  return { ...answer, seen: received[before] }
}

describe("the Mac hop's own rules, against a server that drops nothing", () => {
  it('carries no cookie up and no set-cookie down', async () => {
    const answer = await through('/echo', { cookie: 'pagecookie=from-the-page' })
    expect(answer.status).toBe(200)
    expect(answer.seen?.url).toBe(`${FORWARD_PATH}/${lease}/echo`)
    expect(answer.seen?.headers.cookie).toBeUndefined()
    expect(answer.headers['set-cookie']).toBeUndefined()
  })

  it("carries up no window secret, and the stand-in's bearer, never the page's", async () => {
    const answer = await through('/echo', { authorization: 'Bearer from-the-page' })
    expect(answer.seen?.headers[WINDOW_HEADER]).toBeUndefined()
    expect(answer.seen?.headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it("reports the page's origin: its own as self, another as its literal on a read, never the page's own report", async () => {
    const own = `http://127.0.0.1:${opened.port}`
    const fromOwn = await through('/echo', { origin: own })
    expect(fromOwn.seen?.headers[FORWARD_ORIGIN_HEADER]).toBe(FORWARD_SELF_ORIGIN)
    expect(fromOwn.seen?.headers.origin).toBeUndefined()

    const fromElsewhere = await through('/echo', {
      origin: 'http://elsewhere.test',
      [FORWARD_ORIGIN_HEADER]: FORWARD_SELF_ORIGIN
    })
    expect(fromElsewhere.status).toBe(200)
    expect(fromElsewhere.seen?.headers[FORWARD_ORIGIN_HEADER]).toBe('http://elsewhere.test')

    const reportOnly = await through('/echo', { [FORWARD_ORIGIN_HEADER]: FORWARD_SELF_ORIGIN })
    expect(reportOnly.status).toBe(200)
    expect(reportOnly.seen?.headers[FORWARD_ORIGIN_HEADER]).toBeUndefined()
  })

  it('turns an answer marked refused into the away page, and the mark never reaches the page', async () => {
    const answer = await through('/refused', { 'sec-fetch-mode': 'navigate', accept: 'text/html' })
    expect(answer.seen?.url).toBe(`${FORWARD_PATH}/${lease}/refused`)
    expect(answer.status).toBe(503)
    expect(answer.headers['content-type']).toMatch(/^text\/html/)
    expect(answer.headers[FORWARD_REFUSED_HEADER]).toBeUndefined()
    expect(answer.body.toString()).not.toContain('no such lease')
  })
})

describe("the Mac hop's log", () => {
  it('names a forward by its label, never by its lease', async () => {
    // A port nobody listens on: taken, then given back.
    const spare = http.createServer()
    await new Promise<void>((resolve) => spare.listen(0, '127.0.0.1', resolve))
    const port = (spare.address() as AddressInfo).port
    await new Promise<void>((resolve) => spare.close(() => resolve()))
    const lines: string[] = []
    const logged = new LoopbackForwards({ log: (line) => lines.push(line) })
    const silent = randomBytes(16).toString('hex')
    const forward = await logged.open({
      key: `server-down:${silent}`,
      label: 'server-down',
      lease: silent,
      upstream: async () => ({ url: `http://127.0.0.1:${port}`, token: TOKEN })
    })
    try {
      const answer = await ask(forward.port, '/', {
        headers: {
          [WINDOW_HEADER]: logged.secrets().get(forward.port)!,
          'sec-fetch-mode': 'navigate',
          accept: 'text/html'
        }
      })
      expect(answer.status).toBe(503)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('server-down')
      expect(lines[0]).not.toMatch(/[0-9a-f]{32}/)
    } finally {
      await logged.closeAll()
    }
  })

  it("names it by its label when the server's address cannot be read, never by its lease", async () => {
    const lines: string[] = []
    const logged = new LoopbackForwards({ log: (line) => lines.push(line) })
    const silent = randomBytes(16).toString('hex')
    const forward = await logged.open({
      key: `server-gone:${silent}`,
      label: 'server-gone',
      lease: silent,
      upstream: () => Promise.reject(new Error('the server is not connected'))
    })
    try {
      const answer = await ask(forward.port, '/', {
        headers: {
          [WINDOW_HEADER]: logged.secrets().get(forward.port)!,
          'sec-fetch-mode': 'navigate',
          accept: 'text/html'
        }
      })
      expect(answer.status).toBe(503)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('server-gone')
      expect(lines[0]).not.toMatch(/[0-9a-f]{32}/)
    } finally {
      await logged.closeAll()
    }
  })
})
