import * as fs from 'fs'
import { StringDecoder } from 'string_decoder'
import { listPiFiles, piRoot } from './session-history/pi'

export type PiUsageRange = 'today' | '7d' | '30d' | 'all'
export interface PiUsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
  sessions: number
  range: PiUsageRange
}

interface UsageRecord extends Omit<PiUsageTotals, 'sessions' | 'range'> {
  at: number
}

const READ_CHUNK_BYTES = 64 * 1024
const MAX_JSONL_LINE_CHARS = 1024 * 1024

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function parsePiUsageLine(line: string): UsageRecord | null {
  if (!line.includes('"usage"')) return null
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  const message =
    entry.message && typeof entry.message === 'object'
      ? (entry.message as Record<string, unknown>)
      : null
  const usage = (message?.usage ?? entry.usage) as Record<string, unknown> | undefined
  if (!usage || typeof usage !== 'object') return null
  const cost =
    usage.cost && typeof usage.cost === 'object' ? (usage.cost as Record<string, unknown>) : null
  const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  if (Number.isNaN(at)) return null
  const input = number(usage.input)
  const output = number(usage.output)
  const cacheRead = number(usage.cacheRead)
  const cacheWrite = number(usage.cacheWrite)
  return {
    at,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: number(usage.totalTokens) || input + output + cacheRead + cacheWrite,
    cost: number(cost?.total)
  }
}

export function parsePiUsageLines(lines: Iterable<string>): UsageRecord[] {
  const records: UsageRecord[] = []
  for (const line of lines) {
    const record = parsePiUsageLine(line)
    if (record) records.push(record)
  }
  return records
}

function readJsonlLinesSync(filePath: string, onLine: (line: string) => void): void {
  const fd = fs.openSync(filePath, 'r')
  const decoder = new StringDecoder('utf8')
  const buffer = Buffer.alloc(READ_CHUNK_BYTES)
  let carry = ''
  let skippingLongLine = false

  const feed = (text: string): void => {
    let rest = text
    while (rest.length > 0) {
      const newline = rest.indexOf('\n')
      const chunk = newline === -1 ? rest : rest.slice(0, newline)
      rest = newline === -1 ? '' : rest.slice(newline + 1)

      if (skippingLongLine) {
        if (newline !== -1) skippingLongLine = false
        continue
      }
      if (carry.length + chunk.length > MAX_JSONL_LINE_CHARS) {
        carry = ''
        if (newline === -1) skippingLongLine = true
        continue
      }

      carry += chunk
      if (newline !== -1) {
        onLine(carry.endsWith('\r') ? carry.slice(0, -1) : carry)
        carry = ''
      }
    }
  }

  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      feed(decoder.write(buffer.subarray(0, bytesRead)))
    }
    const tail = decoder.end()
    if (tail) feed(tail)
    if (!skippingLongLine && carry) onLine(carry.endsWith('\r') ? carry.slice(0, -1) : carry)
  } finally {
    fs.closeSync(fd)
  }
}

export function scanPiUsageFile(filePath: string): UsageRecord[] {
  const records: UsageRecord[] = []
  readJsonlLinesSync(filePath, (line) => {
    const record = parsePiUsageLine(line)
    if (record) records.push(record)
  })
  return records
}

function cutoff(range: PiUsageRange, now: Date): number {
  if (range === 'all') return 0
  if (range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return now.getTime() - (range === '7d' ? 7 : 30) * 24 * 60 * 60 * 1000
}

export class PiUsageManager {
  private readonly cache = new Map<
    string,
    { size: number; mtimeMs: number; records: UsageRecord[] }
  >()

  get(range: PiUsageRange, now = new Date()): PiUsageTotals {
    const since = cutoff(range, now)
    const totals: PiUsageTotals = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
      sessions: 0,
      range
    }
    for (const filePath of listPiFiles(piRoot())) {
      let stat: fs.Stats
      try {
        stat = fs.statSync(filePath)
      } catch {
        continue
      }
      let cached = this.cache.get(filePath)
      if (!cached || cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) {
        try {
          cached = { size: stat.size, mtimeMs: stat.mtimeMs, records: scanPiUsageFile(filePath) }
          this.cache.set(filePath, cached)
        } catch {
          continue
        }
      }
      const records = cached.records.filter(
        (record) => record.at >= since && record.at <= now.getTime()
      )
      if (records.length > 0) totals.sessions++
      for (const record of records) {
        totals.input += record.input
        totals.output += record.output
        totals.cacheRead += record.cacheRead
        totals.cacheWrite += record.cacheWrite
        totals.totalTokens += record.totalTokens
        totals.cost += record.cost
      }
    }
    return totals
  }
}

export const piUsageManager = new PiUsageManager()

// ── PRDCT-4551: Pi's records per session, for the attribution per connection ──

/** One Pi model call, with the session and the provider it was made under. */
export interface PiSessionRecord {
  sessionId: string
  at: number
  provider: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
}

const FILE_SESSION_ID = /_([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.jsonl$/

/**
 * Every usage record of one Pi session file (Pi 1.5.2's format, read off a
 * real session on 14 November 2026): an assistant message carries
 * `provider`, `model` and `usage`; a `usage` entry carries the same; a
 * compaction or a branch summary carries `usage` alone, and is counted
 * under the provider the session last named (its last `model_change` or
 * assistant message), the one that wrote it. The session id is the
 * header's, else the file name's.
 */
export function scanPiSessionFile(filePath: string): PiSessionRecord[] {
  let sessionId: string | null = null
  let lastProvider: string | null = null
  const pending: Omit<PiSessionRecord, 'sessionId'>[] = []
  readJsonlLinesSync(filePath, (line) => {
    const usage = line.includes('"usage"') ? parsePiUsageLine(line) : null
    if (
      !usage &&
      !line.includes('"type":"session"') &&
      !line.includes('"provider"') &&
      !line.includes('"model_change"')
    )
      return
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (entry.type === 'session' && typeof entry.id === 'string' && !sessionId) {
      sessionId = entry.id
      return
    }
    const message =
      entry.message && typeof entry.message === 'object'
        ? (entry.message as Record<string, unknown>)
        : null
    const named =
      typeof message?.provider === 'string'
        ? message.provider
        : typeof entry.provider === 'string'
          ? entry.provider
          : null
    if (named) lastProvider = named
    if (!usage) return
    pending.push({ ...usage, provider: named ?? lastProvider })
  })
  const id = sessionId ?? FILE_SESSION_ID.exec(filePath)?.[1] ?? null
  if (!id) return []
  return pending.map((record) => ({ ...record, sessionId: id }))
}

/**
 * Pi's records across its session folders, each file read once per change
 * (its size and modification time), as `PiUsageManager` caches. A file
 * reached twice (a connection's folder linked to the person's) is read once.
 */
export class PiSessionRecords {
  private readonly cache = new Map<
    string,
    { size: number; mtimeMs: number; records: PiSessionRecord[] }
  >()

  read(roots: readonly string[]): PiSessionRecord[] {
    const out: PiSessionRecord[] = []
    const seen = new Set<string>()
    for (const root of roots) {
      for (const filePath of listPiFiles(root)) {
        let real: string
        let stat: fs.Stats
        try {
          real = fs.realpathSync(filePath)
          stat = fs.statSync(real)
        } catch {
          continue
        }
        if (seen.has(real)) continue
        seen.add(real)
        let cached = this.cache.get(real)
        if (!cached || cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) {
          try {
            cached = { size: stat.size, mtimeMs: stat.mtimeMs, records: scanPiSessionFile(real) }
            this.cache.set(real, cached)
          } catch {
            continue
          }
        }
        out.push(...cached.records)
      }
    }
    return out
  }
}
