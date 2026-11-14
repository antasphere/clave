/**
 * The rule of attribution (PRDCT-4551), pure: which connection a Pi or an
 * OpenCode usage record is counted to.
 *
 * A record belongs to the connection in force for its session at its time
 * (the last ledger line of that session at or before the record), and only
 * if the record's provider is the one that connection gives that harness
 * (`connectionModelProvider`). Everything else is counted to the harness's
 * own sign-in: a session the ledger does not know, a record from before a tab
 * was put on a connection, a record of another provider written while a tab
 * named a connection. Two connections of one provider never share a record:
 * each record has one line in force, and that line names one connection.
 */
import {
  EMPTY_FIGURES,
  type HarnessUsageFigures,
  type HarnessUsageRange,
  type UsageHarness
} from '@clave/contract/settings/harness-usage-view'

/** One start or resume of a Pi or an OpenCode tab (the ledger's line). */
export interface LedgerLine {
  harness: UsageHarness
  /** The harness's own session id. */
  sessionId: string
  /** The stored connection the tab ran on, or null for the harness's own sign-in. */
  connectionId: string | null
  /** The connection's label at that moment; null on no connection. */
  label: string | null
  /** The connection's provider company at that moment; null on no connection. */
  company: string | null
  /** When the tab started, epoch ms. */
  at: number
}

/** One model call a harness recorded. */
export interface UsageRecord {
  harness: UsageHarness
  sessionId: string
  at: number
  /** The provider the harness named the model under; null when it said none. */
  provider: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
}

/** The key of a row: a harness and a connection, '' for the sign-in. */
export const rowKey = (harness: UsageHarness, connectionId: string | null): string =>
  `${harness}\u0000${connectionId ?? ''}`

export interface AttributedRow {
  harness: UsageHarness
  connectionId: string | null
  figures: HarnessUsageFigures
  /** The providers its records were made under (null: a record that named
   *  none), which decide whether a sign-in's line may say a cost. */
  providers: Set<string | null>
}

/** The first moment a range counts from. Today: since local midnight. */
export function rangeStart(range: HarnessUsageRange, now: Date): number {
  if (range === 'all') return 0
  if (range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return now.getTime() - (range === '7d' ? 7 : 30) * 24 * 60 * 60 * 1000
}

/** The ledger's lines grouped by harness and session, each list by time. */
export function indexLedger(ledger: readonly LedgerLine[]): Map<string, LedgerLine[]> {
  const out = new Map<string, LedgerLine[]>()
  for (const line of ledger) {
    const key = `${line.harness}\u0000${line.sessionId}`
    const list = out.get(key)
    if (list) list.push(line)
    else out.set(key, [line])
  }
  for (const list of out.values()) list.sort((a, b) => a.at - b.at)
  return out
}

/** The line in force for a record: the last one of its session at or before it. */
export function lineInForce(
  index: Map<string, LedgerLine[]>,
  record: Pick<UsageRecord, 'harness' | 'sessionId' | 'at'>
): LedgerLine | undefined {
  const lines = index.get(`${record.harness}\u0000${record.sessionId}`)
  if (!lines) return undefined
  let found: LedgerLine | undefined
  for (const line of lines) {
    if (line.at > record.at) break
    found = line
  }
  return found
}

/** The connection a record is counted to, or null for the harness's own sign-in. */
export function connectionOfRecord(
  index: Map<string, LedgerLine[]>,
  record: UsageRecord,
  providerOf: (company: string, harness: UsageHarness) => string | undefined
): string | null {
  const line = lineInForce(index, record)
  if (!line || !line.connectionId || !line.company) return null
  const provider = providerOf(line.company, record.harness)
  return provider !== undefined && record.provider === provider ? line.connectionId : null
}

/**
 * Every record of the range counted to its row. A row is listed only when
 * it counted something; the caller adds the rows a person expects to see at
 * zero (the current connections, the sign-in).
 */
export function attributeUsage(input: {
  records: Iterable<UsageRecord>
  ledger: readonly LedgerLine[]
  range: HarnessUsageRange
  now: Date
  providerOf: (company: string, harness: UsageHarness) => string | undefined
}): Map<string, AttributedRow> {
  const since = rangeStart(input.range, input.now)
  const until = input.now.getTime()
  const index = indexLedger(input.ledger)
  const rows = new Map<string, AttributedRow>()
  const sessions = new Map<string, Set<string>>()
  for (const record of input.records) {
    if (record.at < since || record.at > until) continue
    const connectionId = connectionOfRecord(index, record, input.providerOf)
    const key = rowKey(record.harness, connectionId)
    let row = rows.get(key)
    if (!row) {
      row = {
        harness: record.harness,
        connectionId,
        figures: { ...EMPTY_FIGURES },
        providers: new Set()
      }
      rows.set(key, row)
    }
    row.providers.add(record.provider)
    const f = row.figures
    f.requests += 1
    f.input += record.input
    f.output += record.output
    f.cacheRead += record.cacheRead
    f.cacheWrite += record.cacheWrite
    f.totalTokens += record.totalTokens
    f.cost += record.cost
    let seen = sessions.get(key)
    if (!seen) sessions.set(key, (seen = new Set()))
    if (!seen.has(record.sessionId)) {
      seen.add(record.sessionId)
      f.sessions += 1
    }
  }
  return rows
}
