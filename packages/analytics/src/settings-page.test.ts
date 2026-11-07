import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { emptyLedger, type Ledger } from './ledger'
import { EMPTY_PRICES } from './prices'
import { startServer, type AnalyticsServer, type SettingsData, type SettingsPatch } from './server'
import { Store } from './store'

/**
 * The settings page as the real server serves it from the built `dist/` folder. The build
 * is made here when the folder holds none, so the suite never skips this page.
 */

const pageDir = join(__dirname, '../../../apps/plugins/analytics', 'dist')
const built = (): boolean =>
  existsSync(join(pageDir, 'settings.html')) && existsSync(join(pageDir, 'settings.js'))

class FakeCollector extends EventEmitter {
  constructor(readonly ledger: Ledger) {
    super()
  }
}

const fixed: SettingsData = {
  gapMinutes: 15,
  gapBounds: { min: 1, max: 1440 },
  prices: {
    source: 'Anthropic list prices',
    date: '2026-10-01',
    models: {
      'claude-test': {
        name: 'Test model',
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite5m: 3.75,
        cacheWrite1h: 6
      }
    }
  },
  override: false,
  shipped: { date: '2026-10-01', source: 'Anthropic list prices' }
}

interface Reply {
  status: number
  type: string | undefined
  body: string
}

function call(url: string, method = 'GET', body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { 'content-type': 'application/json' } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (text += chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body: text })
      )
    })
    req.on('error', reject)
    req.end(body)
  })
}

let dir: string
let server: AnalyticsServer
let base: string
const patches: SettingsPatch[] = []

beforeAll(async () => {
  if (!built()) {
    execFileSync(
      process.execPath,
      [join(__dirname, '..', '..', '..', 'scripts', 'build-plugins.mjs')],
      {
        stdio: 'ignore'
      }
    )
  }
  dir = mkdtempSync(join(tmpdir(), 'analytics-settings-page-'))
  server = await startServer({
    store: new Store(join(dir, 'data')),
    collector: new FakeCollector(emptyLedger(15, new Date('2026-10-02T10:00:00.000Z'))),
    prices: EMPTY_PRICES,
    pageDir,
    host: '127.0.0.1',
    settings: {
      get: () => fixed,
      apply: (patch) => {
        patches.push(patch)
        return { ...fixed, gapMinutes: patch.gapMinutes ?? fixed.gapMinutes }
      }
    }
  })
  const page = new URL(server.url('workspace', 'none', null))
  base = `${page.origin}/${page.pathname.split('/')[1]}`
})

afterAll(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the built settings page', () => {
  it('carries the settings-data block and loads its script', async () => {
    const page = await call(`${base}/settings`)
    expect(page.status).toBe(200)
    expect(page.type).toContain('text/html')
    const m = /<script type="application\/json" id="settings-data">([\s\S]*?)<\/script>/.exec(
      page.body
    )
    expect(m).not.toBeNull()
    expect(JSON.parse(m![1]!)).toEqual(fixed)
    const token = base.split('/').pop()
    expect(page.body).toContain(`<script src="/${token}/assets/settings.js"></script>`)
    expect(page.body).toContain(`href="/${token}/assets/deck.css"`)
  })

  it('serves the script as JavaScript, the price actions in it', async () => {
    const script = await call(`${base}/assets/settings.js`)
    expect(script.status).toBe(200)
    expect(script.type).toBe('text/javascript; charset=utf-8')
    expect(script.body).toContain('save-prices')
    expect(script.body).toContain('settings-data')
  })

  it('serves the stylesheet with the settings rules appended', async () => {
    const css = await call(`${base}/assets/deck.css`)
    expect(css.status).toBe(200)
    expect(css.body).toContain('.settings .settings-status')
  })

  it('applies a posted patch and answers the data in force', async () => {
    const reply = await call(`${base}/settings`, 'POST', JSON.stringify({ gapMinutes: 20 }))
    expect(reply.status).toBe(200)
    expect((JSON.parse(reply.body) as SettingsData).gapMinutes).toBe(20)
    expect(patches).toEqual([{ gapMinutes: 20 }])
  })
})
