import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { LEDGER_VERSION, emptyLedger, type Ledger, type SessionRow } from './ledger'
import type { PriceTable } from './prices'
import { DEFAULT_SETTINGS, parseSettings, type Settings } from './settings'

/**
 * The plugin's own files in its data folder, each written atomically (`<file>.tmp`, then
 * `rename`): `server.json` (the port, the URL token and the viewer's port), `ledger.json`,
 * `settings.json` (the activity gap) and `prices.json`, the price override the settings page
 * writes (absent by default; a copy a person drops there by hand reads the same). The deck
 * folders under `decks/` are the deck writer's.
 */

export interface ServerInfo {
  port: number
  token: string
  /** The port the Slideless viewer listened on last, asked for again at the next start. */
  viewerPort?: number
}

export type Logger = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
export type StoreFs = Pick<
  typeof nodeFs,
  'mkdirSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'existsSync' | 'rmSync'
>

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === 'string'
const TOKEN_KEYS = [
  'input',
  'cacheWrite5m',
  'cacheWrite1h',
  'cacheWriteUnsplit',
  'cacheRead',
  'output'
]
const isTokens = (v: unknown): boolean => isObj(v) && TOKEN_KEYS.every((k) => isNum(v[k]))
const isDay = (v: unknown): boolean =>
  isObj(v) && isTokens(v) && isNum(v['messages']) && isNum(v['toolCalls'])
const isTally = (v: unknown): boolean =>
  isObj(v) &&
  isTokens(v['tokens']) &&
  isObj(v['byModel']) &&
  Object.values(v['byModel']).every(isTokens) &&
  isObj(v['days']) &&
  Object.values(v['days']).every(isDay) &&
  isNum(v['messages']) &&
  isNum(v['toolCalls']) &&
  isNum(v['prompts']) &&
  Array.isArray(v['stamps']) &&
  Array.isArray(v['toolStamps']) &&
  isStrOrNull(v['firstAt']) &&
  isStrOrNull(v['lastAt'])
const isCursor = (v: unknown): boolean =>
  isObj(v) &&
  typeof v['path'] === 'string' &&
  isNum(v['offset']) &&
  typeof v['partial'] === 'string' &&
  Array.isArray(v['seen'])
const isSubagent = (v: unknown): boolean =>
  isObj(v) && typeof v['id'] === 'string' && isTally(v['tally']) && isCursor(v['file'])

/** A ledger row the views can draw, checked down to its tallies and cursors: anything else
 *  is dropped at load, never served, so one row of a hand-edited file cannot blank a page. */
export function isSessionRow(value: unknown): value is SessionRow {
  if (!isObj(value)) return false
  const root = value['root']
  const group = value['group']
  return (
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['provider'] === 'string' &&
    typeof value['cwd'] === 'string' &&
    typeof value['state'] === 'string' &&
    typeof value['seenAt'] === 'string' &&
    isNum(value['createdAt']) &&
    (group === null ||
      (isObj(group) && typeof group['id'] === 'string' && typeof group['name'] === 'string')) &&
    Array.isArray(value['subagents']) &&
    value['subagents'].every(isSubagent) &&
    Array.isArray(value['stateSpans']) &&
    (root === null || (isObj(root) && isTally(root['tally']) && isCursor(root['file'])))
  )
}

export class Store {
  private warned = false

  constructor(
    readonly dir: string,
    private readonly log: Logger = () => {},
    private readonly fs: StoreFs = nodeFs
  ) {
    this.fs.mkdirSync(dir, { recursive: true })
  }

  get pricesPath(): string {
    return join(this.dir, 'prices.json')
  }

  private readJson(name: string): unknown {
    return JSON.parse(this.fs.readFileSync(join(this.dir, name), 'utf8'))
  }

  private writeJson(name: string, value: unknown): void {
    const file = join(this.dir, name)
    const tmp = `${file}.tmp`
    this.fs.writeFileSync(tmp, JSON.stringify(value))
    this.fs.renameSync(tmp, file)
  }

  readServer(): ServerInfo | null {
    try {
      const raw = this.readJson('server.json') as Partial<ServerInfo>
      if (
        typeof raw.port === 'number' &&
        Number.isInteger(raw.port) &&
        typeof raw.token === 'string' &&
        /^[0-9a-f]{32}$/.test(raw.token)
      ) {
        const viewerPort = raw.viewerPort
        return typeof viewerPort === 'number' && Number.isInteger(viewerPort) && viewerPort > 0
          ? { port: raw.port, token: raw.token, viewerPort }
          : { port: raw.port, token: raw.token }
      }
    } catch {
      /* missing or unreadable: a new one is minted */
    }
    return null
  }

  writeServer(info: ServerInfo): void {
    this.writeJson('server.json', info)
  }

  /** The settings in the data folder; the defaults when the file is missing or off. */
  readSettings(): Settings {
    try {
      return parseSettings(this.readJson('settings.json'))
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  writeSettings(settings: Settings): void {
    this.writeJson('settings.json', settings)
  }

  /** Whether a price override sits in the data folder. */
  hasPrices(): boolean {
    return this.fs.existsSync(this.pricesPath)
  }

  /** Writes the person's own price table over the shipped one. */
  writePrices(table: PriceTable): void {
    this.writeJson('prices.json', table)
  }

  /** Removes the override: the shipped table is in force again. */
  removePrices(): void {
    this.fs.rmSync(this.pricesPath, { force: true })
  }

  /** The stored ledger, or an empty one when the file is missing or does not parse. */
  readLedger(gapMinutes = 15): Ledger {
    let raw: unknown
    try {
      raw = this.readJson('ledger.json')
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      if (!missing) this.warnOnce('ledger.json does not parse; starting from an empty ledger')
      return emptyLedger(gapMinutes)
    }
    const ledger = raw as Partial<Ledger> | null
    if (!ledger || typeof ledger.sessions !== 'object' || !ledger.sessions) {
      this.warnOnce('ledger.json has an unknown shape; starting from an empty ledger')
      return emptyLedger(gapMinutes)
    }
    if (ledger.v !== LEDGER_VERSION) {
      this.warnOnce(
        `ledger.json is version ${String(ledger.v)}, this build writes ${LEDGER_VERSION}; the transcripts are counted again`
      )
      return emptyLedger(gapMinutes)
    }
    const sessions: Record<string, SessionRow> = {}
    let dropped = 0
    for (const [id, row] of Object.entries(ledger.sessions as Record<string, unknown>)) {
      if (isSessionRow(row)) sessions[id] = row
      else dropped++
    }
    if (dropped > 0)
      this.warnOnce(`ledger.json holds ${dropped} row(s) of an unknown shape; they are left out`)
    return {
      v: LEDGER_VERSION,
      gapMinutes: typeof ledger.gapMinutes === 'number' ? ledger.gapMinutes : gapMinutes,
      sessions,
      updatedAt: typeof ledger.updatedAt === 'string' ? ledger.updatedAt : new Date().toISOString()
    }
  }

  writeLedger(ledger: Ledger): void {
    this.writeJson('ledger.json', ledger)
  }

  private warnOnce(message: string): void {
    if (this.warned) return
    this.warned = true
    this.log('warn', message)
  }
}
