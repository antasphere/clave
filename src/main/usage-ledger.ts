/**
 * The ledger of starts (PRDCT-4551): every start and every resume of a Pi or
 * an OpenCode tab, terminal and chat, appends one line naming the harness,
 * the harness's own session id, the connection the tab runs on (or none),
 * that connection's label and provider company at that moment, and the time.
 * It is what the rule of attribution reads (`usage-attribution.ts`) to count
 * a record to the connection its session ran on, and it is the only thing
 * Clave writes for usage: the figures stay in the harnesses' own records.
 *
 * One JSONL document of the host's data folder, through the storage port
 * (the Mac's data folder, or a Clave server's). It holds no value of any
 * key: an id, a label, a company name.
 */
import type { StoragePort } from './ports/storage'
import { lazySettingsPorts } from './ports/registry'
import type { UsageHarness } from '@clave/contract/settings/harness-usage-view'
import type { LedgerLine } from './usage-attribution'

export const USAGE_LEDGER_FILE = 'usage-ledger.jsonl'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

function lineOf(value: unknown): LedgerLine | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.harness !== 'pi' && v.harness !== 'opencode') return null
  if (typeof v.sessionId !== 'string' || !SAFE_ID.test(v.sessionId)) return null
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return null
  const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null)
  return {
    harness: v.harness,
    sessionId: v.sessionId,
    connectionId: str(v.connectionId),
    label: str(v.label),
    company: str(v.company),
    at: v.at
  }
}

/** The lines of a ledger document; a line that does not parse is skipped. */
export function parseLedger(text: string | null): LedgerLine[] {
  if (!text) return []
  const out: LedgerLine[] = []
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    try {
      const line = lineOf(JSON.parse(raw))
      if (line) out.push(line)
    } catch {
      // A torn line: skipped.
    }
  }
  return out
}

export interface LedgerStart {
  harness: UsageHarness
  sessionId: string | undefined | null
  connectionId?: string | null
  label?: string | null
  company?: string | null
  /** When the start happened; now when absent. */
  at?: number
}

export class UsageLedger {
  constructor(
    private readonly storage: () => StoragePort,
    private readonly now: () => number = Date.now
  ) {}

  /** Read from the document every time: it is small, and whichever process
   *  of this host wrote last is the one a read must see. */
  read(): LedgerLine[] {
    try {
      return parseLedger(this.storage().read(USAGE_LEDGER_FILE))
    } catch {
      return []
    }
  }

  /**
   * One line for a start, unless the session's last line already names the
   * same connection under the same label (an adoption of a tab that never
   * stopped, a chat's session told twice): the attribution would not change.
   * Never throws: a ledger that cannot be written costs the count, never a
   * tab's start. Answers the line written, or null.
   */
  record(start: LedgerStart): LedgerLine | null {
    try {
      if (!start.sessionId || !SAFE_ID.test(start.sessionId)) return null
      const line: LedgerLine = {
        harness: start.harness,
        sessionId: start.sessionId,
        connectionId: start.connectionId || null,
        label: start.connectionId ? start.label || null : null,
        company: start.connectionId ? start.company || null : null,
        at: start.at ?? this.now()
      }
      const storage = this.storage()
      const text = storage.read(USAGE_LEDGER_FILE) ?? ''
      const last = parseLedger(text)
        .reverse()
        .find((l) => l.harness === line.harness && l.sessionId === line.sessionId)
      if (
        last &&
        last.connectionId === line.connectionId &&
        last.label === line.label &&
        last.company === line.company
      )
        return null
      const sep = text && !text.endsWith('\n') ? '\n' : ''
      storage.write(USAGE_LEDGER_FILE, `${text}${sep}${JSON.stringify(line)}\n`)
      return line
    } catch (error) {
      console.warn('[usage-ledger] a start was not recorded:', (error as Error).message)
      return null
    }
  }
}

// ── The host's instance ─────────────────────────────────────────────────────

/** The host's ledger of starts, on its own storage port (the Mac's data
 *  folder, or a Clave server's), looked up at every use. */
export const usageLedger = new UsageLedger(() => lazySettingsPorts.storage)

/**
 * Record a start or a resume of a Pi or an OpenCode tab in the host's
 * ledger, with the connection's label and company as they are at this
 * moment (the store's, else the label the tab carries). The time is taken
 * here, before the process starts, so the line is in force for every record
 * the process then writes. Never throws, never delays the start.
 */
export function recordHarnessStart(start: {
  harness: UsageHarness
  sessionId: string | undefined | null
  connectionId?: string | null
  label?: string | null
}): void {
  if (!start.sessionId) return
  const at = Date.now()
  // The host's storage as it is at the start: the line goes where the tab runs.
  let storage: StoragePort
  try {
    storage = lazySettingsPorts.storage
  } catch (error) {
    console.warn('[usage-ledger] a start was not recorded:', (error as Error).message)
    return
  }
  void (async () => {
    try {
      const { providerConnectionsForListing } = await import('./provider-injection-spawn')
      const listed = start.connectionId
        ? providerConnectionsForListing(start.harness).find((c) => c.id === start.connectionId)
        : undefined
      new UsageLedger(() => storage).record({
        harness: start.harness,
        sessionId: start.sessionId,
        connectionId: start.connectionId ?? null,
        label: listed?.label ?? start.label ?? null,
        company: listed?.company ?? null,
        at
      })
    } catch (error) {
      console.warn('[usage-ledger] a start was not recorded:', (error as Error).message)
    }
  })()
}
