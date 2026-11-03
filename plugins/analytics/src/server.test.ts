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
import { startServer, type AnalyticsServer } from './server'
import { Store } from './store'

const fixture = readFileSync(join(__dirname, 'fixtures', 'session.jsonl'), 'utf8')
const template = readFileSync(join(__dirname, '..', 'page', 'index.html'), 'utf8')

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

let dir: string
let server: AnalyticsServer
let collector: FakeCollector
let base: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'analytics-server-'))
  const pageDir = join(dir, 'dist')
  mkdirSync(pageDir)
  writeFileSync(join(pageDir, 'index.html'), template)
  writeFileSync(join(pageDir, 'deck.js'), 'void 0')
  writeFileSync(join(pageDir, 'deck.css'), ':root{}')
  collector = new FakeCollector(ledger())
  server = await startServer({
    store: new Store(join(dir, 'data')),
    collector,
    prices: loadPrices(join(__dirname, '..', 'prices.json'), null),
    pageDir,
    host: '127.0.0.1'
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
})
