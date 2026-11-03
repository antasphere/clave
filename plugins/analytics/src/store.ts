import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyLedger, type Ledger } from './ledger'

/**
 * The plugin's own files in its data folder, each written atomically (`<file>.tmp`, then
 * `rename`): `server.json` (the port and the URL token), `ledger.json`, and `prices.json`,
 * the price override a person may drop there (absent by default, never written here).
 */

export interface ServerInfo {
  port: number
  token: string
}

export type Logger = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void

export class Store {
  private warned = false

  constructor(
    readonly dir: string,
    private readonly log: Logger = () => {}
  ) {
    mkdirSync(dir, { recursive: true })
  }

  get pricesPath(): string {
    return join(this.dir, 'prices.json')
  }

  private readJson(name: string): unknown {
    return JSON.parse(readFileSync(join(this.dir, name), 'utf8'))
  }

  private writeJson(name: string, value: unknown): void {
    const file = join(this.dir, name)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(value))
    renameSync(tmp, file)
  }

  readServer(): ServerInfo | null {
    try {
      const raw = this.readJson('server.json') as Partial<ServerInfo>
      if (
        typeof raw.port === 'number' &&
        Number.isInteger(raw.port) &&
        typeof raw.token === 'string' &&
        /^[0-9a-f]{32}$/.test(raw.token)
      )
        return { port: raw.port, token: raw.token }
    } catch {
      /* missing or unreadable: a new one is minted */
    }
    return null
  }

  writeServer(info: ServerInfo): void {
    this.writeJson('server.json', info)
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
    if (!ledger || ledger.v !== 1 || typeof ledger.sessions !== 'object' || !ledger.sessions) {
      this.warnOnce('ledger.json has an unknown shape; starting from an empty ledger')
      return emptyLedger(gapMinutes)
    }
    return {
      v: 1,
      gapMinutes: typeof ledger.gapMinutes === 'number' ? ledger.gapMinutes : gapMinutes,
      sessions: ledger.sessions,
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
