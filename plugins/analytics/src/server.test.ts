import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { foldEvents, parseLine } from './claude'
import { emptyLedger, emptyTally, type Ledger, type ScopeView } from './ledger'
import { loadPrices } from './prices'
import type { PublishOutcome, PublishRequest } from './publish'
import { newCursor } from './reader'
import {
  parsePublishBody,
  parseScopeParam,
  parseSettingsPatch,
  scopeParam,
  startServer,
  type AnalyticsServer,
  type SettingsData,
  type SettingsPatch,
  type SettingsPort
} from './server'
import { Store } from './store'

const fixture = readFileSync(join(__dirname, 'fixtures', 'session.jsonl'), 'utf8')
const template = readFileSync(join(__dirname, '..', 'page', 'index.html'), 'utf8')
const settingsTemplate = readFileSync(join(__dirname, '..', 'page', 'settings.html'), 'utf8')
const shippedPrices = loadPrices(join(__dirname, '..', 'prices.json'), null)

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
  body: string
}

function get(url: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    request(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body })
      )
    })
      .on('error', reject)
      .end()
  })
}

// The settings port and the publish the server is handed, recording what reaches them.
let patches: SettingsPatch[] = []
let publishes: PublishRequest[] = []
let publishThrows = false

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

const cannedOutcome: PublishOutcome = {
  ok: true,
  deck: {
    deckId: 'deck-7',
    baseUrl: 'https://share.antasphere.com',
    url: 'https://share.antasphere.com/p/deck-7',
    version: 1,
    n: 1,
    at: '2026-11-04T15:00:00.000Z',
    title: 'Theme · Analytics',
    names: true
  }
}

async function fakePublish(request: PublishRequest): Promise<PublishOutcome> {
  publishes.push(request)
  if (publishThrows) throw new Error('boom')
  return cannedOutcome
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
    prices: loadPrices(join(__dirname, '..', 'prices.json'), null),
    pageDir,
    host: '127.0.0.1',
    log: (level, message) => logged.push(`${level}: ${message}`),
    settings: settingsPort,
    publish: fakePublish
  })
  const page = new URL(server.url('session', 'tab 1', 'ws-1'))
  base = `${page.origin}/${page.pathname.split('/')[1]}`
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
    expect(server.url('group', 'g1', null)).toBe(
      `http://127.0.0.1:${server.port}/${saved.token}/group/g1`
    )
    expect(server.url('workspace', 'ws-1', 'ws-1')).toBe(
      `http://127.0.0.1:${server.port}/${saved.token}/workspace?ws=ws-1`
    )
  })

  it('answers the three pages with their data and theme', async () => {
    const session = await get(server.url('session', 'tab 1', 'ws-1'))
    expect(session.status).toBe(200)
    expect(session.type).toContain('text/html')
    expect(session.body).toContain('<html lang="en" data-theme="dark">')
    expect(session.body).toContain('name="analytics-events" content="/')
    expect(session.body).not.toContain('Dark </script> mode')
    expect(dataBlock(session.body)).toMatchObject({ kind: 'session', name: 'Dark </script> mode' })

    const group = await get(`${server.url('group', 'g1', null)}?theme=coffee&range=7d`)
    expect(group.status).toBe(200)
    expect(group.body).toContain('data-theme="coffee"')
    expect(dataBlock(group.body)).toMatchObject({ kind: 'group', name: 'Theme', range: '7d' })

    const workspace = await get(`${server.url('workspace', 'ws-1', 'ws-1')}&theme=nonsense`)
    expect(workspace.status).toBe(200)
    expect(workspace.body).toContain('data-theme="dark"')
    const ws = dataBlock(workspace.body)
    expect(ws).toMatchObject({ kind: 'workspace', range: 'today' })
    expect(ws.cards.map((c) => c.name)).toEqual(['Theme'])
  })

  it('answers the data of a scope as JSON', async () => {
    const r = await get(`${base}/data/session/tab%201.json`)
    expect(r.status).toBe(200)
    expect(r.type).toContain('application/json')
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
      request(server.url('session', 'tab 1', 'ws-1'), { method: 'POST' }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body })
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
    const page = await headers(server.url('session', 'tab 1', 'ws-1'))
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
      const first = await get(server.url('workspace', 'ws-1', 'ws-1'))
      expect(first.status).toBe(404)
      expect(first.body).toBe('')
      const again = await get(server.url('workspace', 'ws-1', 'ws-1'))
      expect(again.status).toBe(404)
      expect(logged.filter((l) => l.includes('workspace page workspace:ws-1'))).toHaveLength(1)
      // A page that does not walk the broken row still answers.
      expect((await get(server.url('session', 'tab 1', 'ws-1'))).status).toBe(200)
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
          resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body: text })
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

describe('the publish route', () => {
  it('hands the publish the scope view and the cleaned request', async () => {
    publishes = []
    const r = await post(
      `${base}/publish`,
      json({
        scope: 'group:g1',
        names: true,
        theme: 'coffee',
        tokens: { '--surface-0': '#fff', bad: 'x', '--y': 'a}b' }
      })
    )
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toEqual(cannedOutcome)
    expect(publishes).toHaveLength(1)
    const sent = publishes[0]!
    expect(sent.key).toBe('group:g1')
    expect(sent.range).toBe('all')
    expect(sent.names).toBe(true)
    expect(sent.theme).toBe('coffee')
    expect(sent.tokens).toEqual({ '--surface-0': '#fff' })
    expect(sent.data.kind).toBe('group')
    expect(sent.data.name).toBe('Theme')
  })

  it('takes the range given and the defaults for the rest', async () => {
    publishes = []
    const r = await post(`${base}/publish`, json({ scope: 'workspace:ws-1', range: '7d' }))
    expect(r.status).toBe(200)
    expect(publishes).toHaveLength(1)
    const sent = publishes[0]!
    expect(sent.key).toBe('workspace:ws-1')
    expect(sent.range).toBe('7d')
    expect(sent.names).toBe(false)
    expect(sent.theme).toBe('dark')
    expect(sent.tokens).toEqual({})
    expect(sent.data.kind).toBe('workspace')
  })

  it('says why it cannot publish, in a sentence', async () => {
    publishes = []
    const absent = await post(`${base}/publish`, json({ scope: 'session:absent' }))
    expect(absent.status).toBe(404)
    expect(absent.type).toContain('application/json')
    expect(JSON.parse(absent.body)).toEqual({
      ok: false,
      kind: 'failed',
      message: 'Nothing is measured for this page yet.'
    })
    const nope = await post(`${base}/publish`, json({ scope: 'nope' }))
    expect(nope.status).toBe(400)
    expect(JSON.parse(nope.body).error).toBe('The body names no page to publish.')
    expect(publishes).toEqual([])

    publishThrows = true
    try {
      const thrown = await post(`${base}/publish`, json({ scope: 'group:g1' }))
      expect(thrown.status).toBe(200)
      expect(JSON.parse(thrown.body)).toEqual({
        ok: false,
        kind: 'failed',
        message: 'The publish failed: boom'
      })
    } finally {
      publishThrows = false
    }
  })

  it('answers 404 on both routes when the server has no settings and no publish', async () => {
    const own = mkdtempSync(join(tmpdir(), 'analytics-server-bare-'))
    const bare = await startServer({
      store: new Store(join(own, 'data')),
      collector,
      prices: shippedPrices,
      pageDir,
      host: '127.0.0.1'
    })
    try {
      const page = new URL(bare.url('group', 'g1', null))
      const root = `${page.origin}/${page.pathname.split('/')[1]}`
      expect((await get(`${root}/group/g1`)).status).toBe(200)
      expect((await get(`${root}/settings`)).status).toBe(404)
      expect((await get(`${root}/data/settings.json`)).status).toBe(404)
      expect((await post(`${root}/settings`, json({ gapMinutes: 20 }))).status).toBe(404)
      expect((await post(`${root}/publish`, json({ scope: 'group:g1' }))).status).toBe(404)
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

  it('reads a settings patch and a publish body', () => {
    expect(parseSettingsPatch({ gapMinutes: '20' })).toEqual({ patch: { gapMinutes: 20 } })
    expect(parseSettingsPatch([])).toHaveProperty('error')
    expect(parseSettingsPatch([])).not.toHaveProperty('patch')
    expect(parseSettingsPatch({ resetPrices: true, prices: {} })).toEqual({
      patch: { resetPrices: true }
    })
    const theme = parsePublishBody({ scope: 'group:g1', theme: 'nonsense' })
    expect('body' in theme && theme.body.theme).toBe('dark')
    const range = parsePublishBody({ scope: 'group:g1', range: 'yesterday' })
    expect('body' in range && range.body.range).toBe('all')
  })
})
