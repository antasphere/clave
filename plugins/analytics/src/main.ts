import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Collector } from './collector'
import { formatCount, formatMinutes, formatTokens, formatUsd } from './format'
import type { HostApi, PluginActionPreviewRow, PluginActionTarget } from './host'
import { publisher, settingsPort } from './ports'
import { loadPrices, type PriceTable } from './prices'
import { scopeView, startServer, type AnalyticsServer, type Scope } from './server'
import { Store } from './store'

/**
 * Analytics: reads the transcripts of the Claude Code sessions Clave knows, keeps one
 * ledger row per session, serves its pages on loopback for the host's actions, keeps the
 * settings a person edits on its settings page, and publishes a page to Slideless on ask.
 */

const LEDGER_WRITE_MS = 2_000

let collector: Collector | null = null
let server: AnalyticsServer | null = null
let store: Store | null = null
let unsubscribe: (() => void) | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null

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
      publish: publisher({ dir, pageDir, collector, flush: flushLedger, log })
    })
    collector.on('changed', () => {
      table = prices()
    })

    const view = (target: PluginActionTarget): ReturnType<typeof scopeView> =>
      scopeView(collector!.ledger, table, scopeOf(target))

    await api.ui.registerAction('deck', {
      invoke: (t) => ({
        page: {
          url: server!.url(t.kind, t.id, t.workspaceId),
          title: clip(view(t)?.name || 'Analytics', 200) || 'Analytics'
        }
      }),
      preview: (t): PluginActionPreviewRow[] => {
        const v = view(t)
        if (!v) return []
        const f = v.figures
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
        page: { url: server!.url('workspace', t.id, t.workspaceId), title: 'Analytics home' }
      })
    })

    const c = collector
    unsubscribe = await api.sessions.subscribe((sessions) => c.setSessions(sessions))
    c.start()
    await api.log('info', `Analytics serving on 127.0.0.1:${server.port}`)
  },

  async deactivate(): Promise<void> {
    unsubscribe?.()
    unsubscribe = null
    collector?.stop()
    try {
      flushLedger()
    } catch {
      /* the next activation starts from the last good write */
    }
    await server?.close()
    server = null
    collector = null
    store = null
  }
}
