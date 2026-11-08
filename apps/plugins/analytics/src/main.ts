import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Collector } from '../../../../packages/analytics/src/collector'
import { DeckWriter } from '../../../../packages/analytics/src/decks'
import {
  formatCount,
  formatMinutes,
  formatTokens,
  formatUsd
} from '../../../../packages/analytics/src/format'
import type {
  HostApi,
  PluginActionPreviewRow,
  PluginActionTarget
} from '../../../../packages/analytics/src/host'
import { settingsPort } from '../../../../packages/analytics/src/ports'
import { loadPrices, type PriceTable } from '../../../../packages/analytics/src/prices'
import {
  scopeView,
  startServer,
  type AnalyticsServer,
  type Scope
} from '../../../../packages/analytics/src/server'
import { Store } from '../../../../packages/analytics/src/store'
import { VIEWER_NOTE, Viewer } from '../../../../packages/analytics/src/viewer'

/**
 * Analytics: reads the transcripts of the Claude Code sessions Clave knows, keeps one
 * ledger row per session, serves its pages on loopback for the host's actions, keeps the
 * settings a person edits on its settings page, writes each opened page as a Slideless deck
 * folder on disk and runs the Slideless CLI's own viewer over those folders, so the page
 * Clave shows is the viewer's copy, reloaded as the data is rewritten; nothing leaves the Mac.
 */

const LEDGER_WRITE_MS = 2_000
/** How long an open waits for a viewer still starting before it falls back to the plugin's page. */
const OPEN_WAIT_MS = 5_000

let collector: Collector | null = null
let server: AnalyticsServer | null = null
let store: Store | null = null
let viewer: Viewer | null = null
let unsubscribe: (() => void) | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null
let deckTimer: ReturnType<typeof setTimeout> | null = null

function dataDir(api: HostApi): string {
  const fromHost = process.env['CLAVE_PLUGIN_DATA_DIR']
  if (fromHost) return fromHost
  const dir = join(tmpdir(), 'clave-analytics')
  void api.log('warn', `No CLAVE_PLUGIN_DATA_DIR from the host; keeping data in ${dir}`)
  return dir
}

function scopeOf(target: PluginActionTarget): Scope {
  // The renderer names the workspace in view, or `none` when no workspace is open.
  if (target.kind === 'workspace')
    return { kind: 'workspace', ws: workspaceOf(target.id, target.workspaceId) }
  return { kind: target.kind, id: target.id }
}

/** The workspace a target names: its workspace id, else its id unless that is the renderer's `none`. */
function workspaceOf(id: string, workspaceId: string | null): string | null {
  if (workspaceId) return workspaceId
  return id && id !== 'none' ? id : null
}

function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

function flushLedger(): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = null
  if (store && collector) store.writeLedger(collector.ledger)
}

export default {
  async activate(api: HostApi): Promise<void> {
    const dir = dataDir(api)
    mkdirSync(dir, { recursive: true })
    const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string): void => {
      void api.log(level, message)
    }
    store = new Store(dir, log)
    const here = new URL('.', import.meta.url)
    const shipped = fileURLToPath(new URL('prices.json', here))
    const shippedTable = loadPrices(shipped, null)
    const prices = (): PriceTable => loadPrices(shipped, store!.pricesPath)
    let table = prices()

    // The settings file is the gap's one truth; the ledger keeps a copy for its views.
    const settings = store.readSettings()
    const ledger = store.readLedger(settings.gapMinutes)
    collector = new Collector({ ledger, gapMinutes: settings.gapMinutes, log })
    collector.on('changed', () => {
      if (writeTimer) return
      writeTimer = setTimeout(() => {
        writeTimer = null
        try {
          store?.writeLedger(collector!.ledger)
        } catch (error) {
          log('warn', `Could not write the ledger: ${(error as Error).message}`)
        }
      }, LEDGER_WRITE_MS)
    })

    const pageDir = fileURLToPath(new URL('dist/', here))
    const c = collector
    const s = store
    let writer: DeckWriter | null = null
    let v: Viewer | null = null
    server = await startServer({
      store,
      collector,
      // The override is re-read on each ledger change, so a price edit shows without a restart.
      prices: () => table,
      pageDir,
      host: '127.0.0.1',
      log,
      settings: settingsPort({
        store,
        collector,
        shipped: shippedTable,
        prices,
        onTable: (next) => {
          table = next
        }
      }),
      // An open writes the scope's deck and leads to the viewer's copy when the viewer is up
      // (waited for a few seconds while it starts), else to the plugin's own page.
      open: async (scope, range) => {
        const deck = writer?.write(scope, range) ?? null
        const state = v ? await v.ready(OPEN_WAIT_MS) : null
        if (!deck || !state || state.kind !== 'up') return null
        return `${state.url}/${encodeURIComponent(deck.name)}/index.html`
      },
      note: () => v?.note() ?? ''
    })
    const srv = server

    writer = new DeckWriter({
      dir,
      pageDir,
      agentFile: fileURLToPath(new URL('deck/AGENT.md', here)),
      view: (scope, range) => scopeView(c.ledger, table, scope, range),
      base: srv.base,
      note: VIEWER_NOTE,
      log
    })
    writer.ensureRoot()
    const w = writer
    // Every opened deck follows the ledger, debounced like the ledger's own write; the viewer
    // reloads the pages whose folders changed.
    collector.on('changed', () => {
      table = prices()
      if (deckTimer) return
      deckTimer = setTimeout(() => {
        deckTimer = null
        try {
          w.rewrite()
        } catch (error) {
          log('warn', `Could not rewrite the decks: ${(error as Error).message}`)
        }
      }, LEDGER_WRITE_MS)
    })

    v = new Viewer({
      root: w.root,
      savedPort: s.readServer()?.viewerPort ?? null,
      onPort: (port) => {
        const info = s.readServer()
        if (info) s.writeServer({ ...info, viewerPort: port })
      },
      log
    })
    viewer = v
    void v.start()

    const view = (target: PluginActionTarget): ReturnType<typeof scopeView> =>
      scopeView(c.ledger, table, scopeOf(target))

    await api.ui.registerAction('deck', {
      invoke: (t) => ({
        page: {
          url: srv.url(t.kind, t.id, t.workspaceId),
          title: clip(view(t)?.name || 'Analytics', 200) || 'Analytics'
        }
      }),
      preview: (t): PluginActionPreviewRow[] => {
        const data = view(t)
        if (!data) return []
        const f = data.figures
        return [
          { label: 'Cost', value: formatUsd(f.usd) },
          { label: 'Active', value: formatMinutes(f.activeMinutes) },
          { label: 'Read', value: formatTokens(f.tokensRead) },
          { label: 'Written', value: formatTokens(f.tokensWritten) },
          { label: 'Tool calls', value: formatCount(f.toolCalls) },
          { label: 'Prompts', value: formatCount(f.prompts) }
        ]
      }
    })
    await api.ui.registerAction('home', {
      invoke: (t) => ({
        page: { url: srv.url('workspace', t.id, t.workspaceId), title: 'Analytics home' }
      })
    })

    unsubscribe = await api.sessions.subscribe((sessions) => c.setSessions(sessions))
    c.start()
    await api.log('info', `Analytics serving on 127.0.0.1:${srv.port}`)
  },

  async deactivate(): Promise<void> {
    unsubscribe?.()
    unsubscribe = null
    collector?.stop()
    if (deckTimer) clearTimeout(deckTimer)
    deckTimer = null
    try {
      flushLedger()
    } catch {
      /* the next activation starts from the last good write */
    }
    await viewer?.stop()
    viewer = null
    await server?.close()
    server = null
    collector = null
    store = null
  }
}
