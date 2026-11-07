import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { foldEvents, parseLine } from './claude'
import { emptyLedger, emptyTally, type Ledger, type ScopeView } from './ledger'
import { loadPrices } from './prices'
import { newCursor } from './reader'
import {
  parseScopeParam,
  parseSettingsPatch,
  scopeOfPath,
  scopeParam,
  startServer,
  type AnalyticsServer,
  type Scope,
  type SettingsData,
  type SettingsPatch,
  type SettingsPort
} from './server'
import type { Range } from './scope'
import { Store } from './store'

const fixture = readFileSync(join(__dirname, 'fixtures', 'session.jsonl'), 'utf8')
const template = readFileSync(join(__dirname, '../../../apps/plugins/analytics', 'page', 'index.html'), 'utf8')
const settingsTemplate = readFileSync(join(__dirname, '../../../apps/plugins/analytics', 'page', 'settings.html'), 'utf8')
const shippedPrices = loadPrices(join(__dirname, '../../../apps/plugins/analytics', 'prices.json'), null)

class FakeCollector extends EventEmitter {
  constructor(readonly ledger: Ledger) {
    super()
  }
}

function ledger(): Ledger {
  const l = emptyLedger(15, new Date('2026-10-02T10:00:00.000Z'))
  const tally = foldEvents(fixture.split('\n').map(parseLine), emptyTally())
  l.sessions['tab 1'] = {
    id: 'tab 1',
    provider: 'claude',
    providerSessionId: 'conv-1',
    cwd: '/work/example',
    name: 'Dark </script> mode',
    model: null,
    state: 'working',
    group: { id: 'g1', name: 'Theme' },
    workspaceId: 'ws-1',
    createdAt: 1,
    seenAt: '2026-10-02T10:00:00.000Z',
    root: { tally, file: { ...newCursor('/x/conv-1.jsonl'), offset: 10 } },
    subagents: [],
    stateSpans: []
  }
  return l
}

interface Reply {
  status: number
  type: string | undefined
  /** The `access-control-allow-origin` answered, if any. */
  origin: string | undefined
  body: string
}

function get(url: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    request(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          type: res.headers['content-type'],
          origin: res.headers['access-control-allow-origin'],
          body
        })
      )
    })
      .on('error', reject)
      .end()
  })
}

// The settings port and the open port the server is handed, recording what reaches them.
let patches: SettingsPatch[] = []
let opens: { scope: Scope; range: Range }[] = []
/** What the open port answers: a viewer URL, null for the plugin's own page, or a throw. */
let openAnswer: string | null | 'throw' = null
let note = ''

const settingsData = (): SettingsData => ({
  gapMinutes: 15,
  gapBounds: { min: 1, max: 1440 },
  prices: shippedPrices,
  override: false,
  shipped: { date: '2026-11-03', source: 'the shipped table' }
})

const settingsPort: SettingsPort = {
  get: settingsData,
  apply(patch) {
    patches.push(patch)
    const data = settingsData()
    return {
      ...data,
      gapMinutes: patch.gapMinutes ?? data.gapMinutes,
      override: patch.prices !== undefined
    }
  }
}

async function fakeOpen(scope: Scope, range: Range): Promise<string | null> {
  opens.push({ scope, range })
  if (openAnswer === 'throw') throw new Error('boom')
  return openAnswer
}

let dir: string
let pageDir: string
let server: AnalyticsServer
let collector: FakeCollector
let base: string
const logged: string[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'analytics-server-'))
  pageDir = join(dir, 'dist')
  mkdirSync(pageDir)
  writeFileSync(join(pageDir, 'index.html'), template)
  writeFileSync(join(pageDir, 'settings.html'), settingsTemplate)
  writeFileSync(join(pageDir, 'deck.js'), 'void 0')
  writeFileSync(join(pageDir, 'deck.css'), ':root{}')
  collector = new FakeCollector(ledger())
  server = await startServer({
    store: new Store(join(dir, 'data')),
    collector,
    prices: loadPrices(join(__dirname, '../../../apps/plugins/analytics', 'prices.json'), null),
    pageDir,
    host: '127.0.0.1',
    log: (level, message) => logged.push(`${level}: ${message}`),
    settings: settingsPort,
    open: fakeOpen,
    note: () => note
  })
  base = server.base.replace(/\/$/, '')
})

afterAll(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

function dataBlock(html: string): ScopeView {
  const m = /<script type="application\/json" id="slideless-data">([\s\S]*?)<\/script>/.exec(html)
  expect(m).not.toBeNull()
  return JSON.parse(m![1]!) as ScopeView
}

describe('the server', () => {
  it('saves its port and a 32-hex token, and binds to loopback', () => {
    const saved = JSON.parse(readFileSync(join(dir, 'data', 'server.json'), 'utf8'))
    expect(saved.port).toBe(server.port)
    expect(saved.token).toMatch(/^[0-9a-f]{32}$/)
    expect(server.base).toBe(`http://127.0.0.1:${server.port}/${saved.token}/`)
    // The actions lead through the open route; the pages themselves sit beside it.
    expect(server.url('group', 'g1', null)).toBe(`${base}/open/group/g1`)
    expect(server.url('workspace', 'ws-1', 'ws-1')).toBe(`${base}/open/workspace?ws=ws-1`)
    expect(server.url('workspace', 'none', null)).toBe(`${base}/open/workspace`)
    expect(server.pageUrl({ kind: 'group', id: 'g 1' }, '7d')).toBe(`${base}/group/g%201?range=7d`)
    expect(server.pageUrl({ kind: 'workspace', ws: 'ws-1' }, null)).toBe(
      `${base}/workspace?ws=ws-1`
    )
  })

  it('answers the three pages with their data and theme', async () => {
    const session = await get(server.pageUrl({ kind: 'session', id: 'tab 1' }, null))
    expect(session.status).toBe(200)
    expect(session.type).toContain('text/html')
    expect(session.body).toContain('<html lang="en" data-theme="dark">')
    expect(session.body).toContain('name="analytics-events" content="/')
    expect(session.body).not.toContain('Dark </script> mode')
    expect(dataBlock(session.body)).toMatchObject({ kind: 'session', name: 'Dark </script> mode' })

    const group = await get(`${server.pageUrl({ kind: 'group', id: 'g1' }, '7d')}&theme=coffee`)
    expect(group.status).toBe(200)
    expect(group.body).toContain('data-theme="coffee"')
    expect(dataBlock(group.body)).toMatchObject({ kind: 'group', name: 'Theme', range: '7d' })

    const workspace = await get(
      `${server.pageUrl({ kind: 'workspace', ws: 'ws-1' }, null)}&theme=nonsense`
    )
    expect(workspace.status).toBe(200)
    expect(workspace.body).toContain('data-theme="dark"')
    const ws = dataBlock(workspace.body)
    expect(ws).toMatchObject({ kind: 'workspace', range: 'today' })
    expect(ws.cards.map((c) => c.name)).toEqual(['Theme'])
  })

  it('answers the data of a scope as JSON, to any origin, and the pages to none', async () => {
    const r = await get(`${base}/data/session/tab%201.json`)
    expect(r.status).toBe(200)
    expect(r.type).toContain('application/json')
    expect(r.origin).toBe('*')
    expect(
      (await get(server.pageUrl({ kind: 'session', id: 'tab 1' }, null))).origin
    ).toBeUndefined()
    expect((await get(`${base}/data/settings.json`)).origin).toBeUndefined()
    const v = JSON.parse(r.body) as ScopeView
    expect(v.figures.messages).toBe(3)
    expect(v.figures.toolCalls).toBe(5)
    expect((await get(`${base}/data/workspace.json?ws=ws-1&range=all`)).status).toBe(200)
    expect((await get(`${base}/data/session/absent.json`)).status).toBe(404)
  })

  it('answers 404 and no body without the token, or on an unknown route', async () => {
    const origin = new URL(base).origin
    for (const path of [
      '/',
      '/session/tab%201',
      `/${'0'.repeat(32)}/session/tab%201`,
      '/assets/deck.js',
      `${new URL(base).pathname}/nothing`,
      `${new URL(base).pathname}/assets/other.js`
    ]) {
      const r = await get(`${origin}${path}`)
      expect(r.status, path).toBe(404)
      expect(r.body, path).toBe('')
    }
    expect((await get(`${base}/assets/deck.js`)).status).toBe(200)
    expect((await get(`${base}/assets/deck.css`)).type).toContain('text/css')
  })

  it('streams a first data event, then one after the collector changes', async () => {
    const frames: string[] = []
    const url = `${base}/events?scope=${encodeURIComponent('session:tab 1')}`
    await new Promise<void>((resolve, reject) => {
      const req = request(url, (res) => {
        expect(res.headers['content-type']).toContain('text/event-stream')
        expect(res.headers['access-control-allow-origin']).toBe('*')
        res.setEncoding('utf8')
        let buffer = ''
        res.on('data', (chunk: string) => {
          buffer += chunk
          let at: number
          while ((at = buffer.indexOf('\n\n')) >= 0) {
            frames.push(buffer.slice(0, at))
            buffer = buffer.slice(at + 2)
          }
          if (frames.length === 1) {
            collector.ledger.sessions['tab 1']!.name = 'Renamed'
            collector.emit('changed', new Set(['tab 1']))
          }
          if (frames.length === 2) {
            req.destroy()
            resolve()
          }
        })
      })
      req.on('error', (error) => (frames.length >= 2 ? resolve() : reject(error)))
      req.end()
    })
    expect(frames[0]).toMatch(/^event: data\ndata: /)
    const first = JSON.parse(frames[0]!.split('\ndata: ')[1]!) as ScopeView
    const second = JSON.parse(frames[1]!.split('\ndata: ')[1]!) as ScopeView
    expect(first.name).toBe('Dark </script> mode')
    expect(second.name).toBe('Renamed')
  })
  it('answers nothing but GET, and sends the page policy on pages only', async () => {
    const post = await new Promise<Reply>((resolve, reject) => {
      request(server.pageUrl({ kind: 'session', id: 'tab 1' }, null), { method: 'POST' }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            type: res.headers['content-type'],
            origin: res.headers['access-control-allow-origin'],
            body
          })
        )
      })
        .on('error', reject)
        .end()
    })
    expect(post.status).toBe(404)
    expect(post.body).toBe('')
    const headers = (url: string): Promise<Record<string, string | string[] | undefined>> =>
      new Promise((resolve, reject) => {
        request(url, (res) => {
          res.resume()
          res.on('end', () => resolve(res.headers))
        })
          .on('error', reject)
          .end()
      })
    const page = await headers(server.pageUrl({ kind: 'session', id: 'tab 1' }, null))
    expect(String(page['content-security-policy'])).toContain("default-src 'none'")
    expect(String(page['content-security-policy'])).toContain("script-src 'self'")
    const data = await headers(`${base}/data/session/tab%201.json`)
    expect(data['content-security-policy']).toBeUndefined()
  })
  it('answers nothing for a page it cannot draw, says why once, and keeps serving', async () => {
    // A row the views choke on, reached only by the pages that walk every row.
    Object.defineProperty(collector.ledger.sessions, 'broken', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('a row the views cannot read')
      }
    })
    try {
      const first = await get(server.pageUrl({ kind: 'workspace', ws: 'ws-1' }, null))
      expect(first.status).toBe(404)
      expect(first.body).toBe('')
      const again = await get(server.pageUrl({ kind: 'workspace', ws: 'ws-1' }, null))
      expect(again.status).toBe(404)
      expect(logged.filter((l) => l.includes('workspace page workspace:ws-1'))).toHaveLength(1)
      // A page that does not walk the broken row still answers.
      expect((await get(server.pageUrl({ kind: 'session', id: 'tab 1' }, null))).status).toBe(200)
      // The live stream of the broken page sends no frame and stays open; once the row is
      // gone, a change brings the frame.
      const frames: string[] = []
      const url = new URL(`${base}/events?scope=workspace:ws-1&range=all`)
      await new Promise<void>((resolve, reject) => {
        const req = request(url, (res) => {
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            frames.push(chunk)
            if (chunk.includes('event: data')) {
              req.destroy()
              resolve()
            }
          })
        })
        req.on('error', (e) => (frames.length ? resolve() : reject(e)))
        req.end()
        setTimeout(() => {
          expect(frames.join('')).not.toContain('event: data')
          delete (collector.ledger.sessions as Record<string, unknown>)['broken']
          collector.emit('changed', new Set(['tab 1']))
        }, 150)
      })
      expect(frames.join('')).toContain('"kind":"workspace"')
    } finally {
      delete (collector.ledger.sessions as Record<string, unknown>)['broken']
    }
  })
})

function post(url: string, body: string, type = 'application/json'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': type, 'content-length': Buffer.byteLength(body) }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (text += chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            type: res.headers['content-type'],
            origin: res.headers['access-control-allow-origin'],
            body: text
          })
        )
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

const json = (value: unknown): string => JSON.stringify(value)

function settingsBlock(html: string): SettingsData {
  const m = /<script type="application\/json" id="settings-data">([\s\S]*?)<\/script>/.exec(html)
  expect(m).not.toBeNull()
  return JSON.parse(m![1]!) as SettingsData
}

const fullTable = {
  source: 'mine',
  date: '2026-11-04',
  models: {
    'claude-x': {
      name: 'Claude X',
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite5m: 3.75,
      cacheWrite1h: 6
    }
  }
}

describe('the settings routes', () => {
  it('answers the settings page and its data', async () => {
    const page = await get(`${base}/settings`)
    expect(page.status).toBe(200)
    expect(page.type).toContain('text/html')
    expect(page.body).toContain('id="settings-data"')
    const data = settingsBlock(page.body)
    expect(data).toEqual(settingsData())
    expect(data.gapMinutes).toBe(15)
    expect(data.override).toBe(false)
    expect(page.body).toContain('assets/settings.js')
    expect(page.body).toContain('<meta name="analytics-mode" content="live" />')

    const r = await get(`${base}/data/settings.json`)
    expect(r.status).toBe(200)
    expect(r.type).toContain('application/json')
    expect(JSON.parse(r.body)).toEqual(settingsData())
  })

  it('applies a valid patch and refuses the rest', async () => {
    patches = []
    const gap = await post(`${base}/settings`, json({ gapMinutes: 20 }))
    expect(gap.status).toBe(200)
    expect(JSON.parse(gap.body)).toEqual({ ...settingsData(), gapMinutes: 20 })
    expect(patches).toEqual([{ gapMinutes: 20 }])

    patches = []
    const zero = await post(`${base}/settings`, json({ gapMinutes: 0 }))
    expect(zero.status).toBe(400)
    expect(JSON.parse(zero.body).error).toBe('The gap is a whole number of minutes from 1 to 1440.')
    expect(patches).toEqual([])

    const partial = await post(
      `${base}/settings`,
      json({ prices: { models: { 'claude-x': { input: 1 } } } })
    )
    expect(partial.status).toBe(400)
    expect(JSON.parse(partial.body).error).toContain('five prices')
    expect(patches).toEqual([])

    const table = await post(`${base}/settings`, json({ prices: fullTable }))
    expect(table.status).toBe(200)
    expect(JSON.parse(table.body).override).toBe(true)
    expect(patches).toHaveLength(1)
    expect(patches[0]!.prices!.models['claude-x']!.input).toBe(3)

    patches = []
    const reset = await post(`${base}/settings`, json({ resetPrices: true }))
    expect(reset.status).toBe(200)
    expect(patches).toEqual([{ resetPrices: true }])

    patches = []
    const text = await post(`${base}/settings`, 'not json')
    expect(text.status).toBe(400)
    expect(JSON.parse(text.body).error).toBe('The body is not JSON.')
    expect(patches).toEqual([])
  })

  it('answers 413 to a body over the limit, and applies nothing', async () => {
    patches = []
    const large = await post(`${base}/settings`, `{"gapMinutes":20,"pad":"${'x'.repeat(290_000)}"}`)
    expect(large.status).toBe(413)
    expect(patches).toEqual([])
  })

  it('answers 404 to a POST anywhere else, or without the right token', async () => {
    patches = []
    const origin = new URL(base).origin
    const page = await post(`${base}/session/tab%201`, json({ gapMinutes: 20 }))
    expect(page.status).toBe(404)
    expect(page.body).toBe('')
    for (const url of [`${origin}/settings`, `${origin}/${'0'.repeat(32)}/settings`]) {
      const r = await post(url, json({ gapMinutes: 20 }))
      expect(r.status, url).toBe(404)
      expect(r.body, url).toBe('')
    }
    expect(patches).toEqual([])
  })
})

describe('the open route', () => {
  /** A GET whose redirect is read, never followed. */
  const head = (
    url: string
  ): Promise<{ status: number; location: string | undefined; length: string | undefined }> =>
    new Promise((resolve, reject) => {
      request(url, (res) => {
        res.resume()
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers['location'],
            length: res.headers['content-length']
          })
        )
      })
        .on('error', reject)
        .end()
    })

  it('hands the open port the scope and the range, and redirects to the viewer URL it answers', async () => {
    opens = []
    openAnswer = 'http://127.0.0.1:4173/group-g1-7d/index.html'
    const r = await head(`${base}/open/group/g1?range=7d`)
    expect(r.status).toBe(302)
    expect(r.location).toBe(openAnswer)
    expect(r.length).toBe('0')
    expect(opens).toEqual([{ scope: { kind: 'group', id: 'g1' }, range: '7d' }])
    opens = []
    await head(`${base}/open/workspace?ws=ws-1`)
    await head(`${base}/open/session/tab%201?range=nonsense`)
    expect(opens).toEqual([
      { scope: { kind: 'workspace', ws: 'ws-1' }, range: 'today' },
      { scope: { kind: 'session', id: 'tab 1' }, range: 'all' }
    ])
  })

  it("redirects to the plugin's own page, the range and the theme kept, when there is no viewer", async () => {
    openAnswer = null
    const r = await head(`${base}/open/group/g1?range=7d&theme=coffee`)
    expect(r.status).toBe(302)
    expect(r.location).toBe(`/${base.split('/').pop()}/group/g1?range=7d&theme=coffee`)
    const ws = await head(`${base}/open/workspace?ws=ws-1`)
    expect(ws.location).toBe(`/${base.split('/').pop()}/workspace?ws=ws-1&range=today`)
  })

  it('falls back to the plugin page when the open port throws, and says why once', async () => {
    openAnswer = 'throw'
    const before = logged.length
    const r = await head(`${base}/open/session/tab%201`)
    expect(r.status).toBe(302)
    expect(r.location).toBe(`/${base.split('/').pop()}/session/tab%201?range=all`)
    expect(logged.slice(before)).toEqual([
      'warn: The deck of session:tab 1 could not be written: boom'
    ])
    openAnswer = null
  })

  it('answers 404 for a scope nothing is measured for, and for a path that names none', async () => {
    opens = []
    expect((await head(`${base}/open/session/absent`)).status).toBe(404)
    expect((await head(`${base}/open/nope`)).status).toBe(404)
    expect((await head(`${base}/open`)).status).toBe(404)
    expect((await head(`${base}/open/group/`)).status).toBe(404)
    expect(opens).toEqual([])
  })

  it("writes the note it is given on the plugin's own page, and nothing on the settings page", async () => {
    note = 'The Slideless viewer is starting; the next open shows this page through it'
    const page = await get(server.pageUrl({ kind: 'session', id: 'tab 1' }, null))
    expect(page.body).toContain(`<meta name="analytics-note" content="${note}" />`)
    expect(page.body).toContain(
      `<meta name="analytics-base" content="/${base.split('/').pop()}/" />`
    )
    const settings = await get(`${base}/settings`)
    expect(settings.body).toContain('<meta name="analytics-base" content="/')
    note = ''
    const bare = await get(server.pageUrl({ kind: 'session', id: 'tab 1' }, null))
    expect(bare.body).toContain('<meta name="analytics-note" content="" />')
  })

  it('redirects to the plugin page and writes no note when the server has no open port', async () => {
    const own = mkdtempSync(join(tmpdir(), 'analytics-server-bare-'))
    const bare = await startServer({
      store: new Store(join(own, 'data')),
      collector,
      prices: shippedPrices,
      pageDir,
      host: '127.0.0.1'
    })
    try {
      const root = bare.base.replace(/\/$/, '')
      const r = await head(`${root}/open/group/g1`)
      expect(r.status).toBe(302)
      expect(r.location).toBe(`/${root.split('/').pop()}/group/g1?range=all`)
      expect((await get(`${root}/group/g1`)).status).toBe(200)
      expect((await get(`${root}/group/g1`)).body).toContain(
        '<meta name="analytics-note" content="" />'
      )
      expect((await get(`${root}/settings`)).status).toBe(404)
      expect((await get(`${root}/data/settings.json`)).status).toBe(404)
      expect((await post(`${root}/settings`, json({ gapMinutes: 20 }))).status).toBe(404)
    } finally {
      await bare.close()
      rmSync(own, { recursive: true, force: true })
    }
  })
})

describe('the request parsers', () => {
  it('writes a scope as its key and reads it back', () => {
    expect(scopeParam({ kind: 'workspace', ws: null })).toBe('workspace:-')
    expect(parseScopeParam('workspace:-')).toEqual({ kind: 'workspace', ws: null })
    expect(scopeParam({ kind: 'session', id: 'tab 1' })).toBe('session:tab 1')
    expect(parseScopeParam('session:tab 1')).toEqual({ kind: 'session', id: 'tab 1' })
    expect(parseScopeParam('group:')).toBeNull()
    expect(parseScopeParam('nope')).toBeNull()
  })

  it('reads the scope a path names', () => {
    const q = new URLSearchParams('ws=ws-1')
    expect(scopeOfPath(['session', 'tab 1'], q)).toEqual({ kind: 'session', id: 'tab 1' })
    expect(scopeOfPath(['group', 'g1'], q)).toEqual({ kind: 'group', id: 'g1' })
    expect(scopeOfPath(['workspace'], q)).toEqual({ kind: 'workspace', ws: 'ws-1' })
    expect(scopeOfPath(['workspace'], new URLSearchParams())).toEqual({
      kind: 'workspace',
      ws: null
    })
    expect(scopeOfPath(['session'], q)).toBeNull()
    expect(scopeOfPath(['session', ''], q)).toBeNull()
    expect(scopeOfPath(['workspace', 'x'], q)).toBeNull()
    expect(scopeOfPath([], q)).toBeNull()
  })

  it('reads a settings patch', () => {
    expect(parseSettingsPatch({ gapMinutes: '20' })).toEqual({ patch: { gapMinutes: 20 } })
    expect(parseSettingsPatch([])).toHaveProperty('error')
    expect(parseSettingsPatch([])).not.toHaveProperty('patch')
    expect(parseSettingsPatch({ resetPrices: true, prices: {} })).toEqual({
      patch: { resetPrices: true }
    })
    // The server refuses a negative price itself, whatever the page's form checked.
    const negative = parseSettingsPatch({
      prices: {
        models: {
          'claude-x': {
            name: 'X',
            input: -5,
            output: 1,
            cacheRead: 1,
            cacheWrite5m: 1,
            cacheWrite1h: 1
          }
        }
      }
    })
    expect('error' in negative && negative.error).toContain('zero or more')
  })
})
