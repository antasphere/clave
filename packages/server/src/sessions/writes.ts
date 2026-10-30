/**
 * Nothing is sent twice (the mobile wave, lane B; decision 10 of the spec
 * `knowledge/specs/2026-10-29-mobile-app.md`, the seam of 29 October 2026
 * `seam-write-status.md` agreed with lanes C and D): a message a client
 * minted an id for lands once on a session, whatever the network did in
 * between, and the client can always learn what became of it.
 *
 * The ledger is persisted per session through the storage adapter the entry
 * gives (`fileWriteLedgerStorage` under the data directory; memory in the
 * tests) and is COMPLETE for the session's life: every id ever received is
 * kept with its status, nothing is evicted, so the ledger alone decides
 * `absent`. Two phases are written BEFORE the provider is touched:
 * `received` when the write arrives, before any validation of the session,
 * then `dispatched` immediately before the message is handed to the
 * provider; then `accepted` with `at` when the provider took it, or
 * `rejected` with a short reason when it refused. A phase that cannot be
 * persisted refuses the write: an entry exists in memory only once it is on
 * disk, which is what keeps the file complete.
 *
 * The server's own history of writes (`evidence`, the second file) records
 * every `user_message` carrying an id as it passes on the session's stream,
 * from where the sessions live, independently of the handler: it is the
 * durable evidence that settles a `dispatched` entry as `accepted` after a
 * restart. Recovery at boot preserves uncertainty: an entry left at
 * `dispatched` becomes `unknown` unless that history carries the id; an
 * entry left at `received` was provably never handed to the provider and
 * becomes `rejected` with the reason `server restarted before dispatch`;
 * nothing is resent by the server, ever. A ledger that cannot be read is
 * put aside and started again marked incomplete: an id it does not hold
 * then reads `unknown`, never `absent`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { Context, Layer } from 'effect'
import type { WriteStatusView } from '@clave/contract/sessions'

/** Where a session's two documents live; the entry picks the place. */
export interface WriteLedgerStorage {
  /** The document, null when there is none; throws when it cannot be read. */
  read(name: string): string | null
  /** Replace the document atomically; throws when it cannot be written. */
  write(name: string, text: string): void
}

export type LedgerEntry =
  | { readonly status: 'received'; readonly at: number }
  | { readonly status: 'dispatched'; readonly at: number }
  | { readonly status: 'accepted'; readonly at: number }
  | { readonly status: 'rejected'; readonly at: number; readonly reason: string }
  | { readonly status: 'unknown'; readonly at: number; readonly reason: string }

interface LedgerDocument {
  readonly v: 1
  /** False once the ledger had to be started again over one that could not be read. */
  readonly complete: boolean
  readonly entries: Record<string, LedgerEntry>
}
interface HistoryDocument {
  readonly v: 1
  readonly items: Array<{ readonly id: string; readonly at: number }>
}

interface SessionLedger {
  complete: boolean
  readonly entries: Map<string, LedgerEntry>
  readonly history: Map<string, number>
}

export const RESTARTED_BEFORE_DISPATCH = 'server restarted before dispatch'
export const STOPPED_AFTER_DISPATCH =
  'the server stopped after the dispatch and before the provider answered'
export const LEDGER_INCOMPLETE =
  'the ledger of this session had to be started again and is incomplete'
export const LEDGER_UNREADABLE = 'the ledger of this session cannot be read'
/** The most a rejection's reason carries. */
export const REASON_MAX = 160

/** A reason a client may see: the error's first line, the message's own text
 *  taken out, whitespace collapsed, bounded. Never a stack. */
export function sanitizeReason(error: unknown, text?: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  let line = raw.split('\n')[0] ?? ''
  if (text && text.trim() !== '') line = line.split(text).join('…')
  line = line.replace(/\s+/g, ' ').trim()
  if (line === '') return 'the write failed'
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}…` : line
}

const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/
/** A file name for any session id: the id itself when it is plain, a hash otherwise. */
export const ledgerFileStem = (sessionId: string): string =>
  SAFE_NAME.test(sessionId) ? sessionId : createHash('sha256').update(sessionId).digest('hex')

export class WriteLedger {
  private readonly sessions = new Map<string, SessionLedger>()

  constructor(
    private readonly storage: WriteLedgerStorage,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = (line) => console.error(`[clave-server] ${line}`)
  ) {}

  /** Only the lifecycle creating a new identity may establish completeness.
   * Restoring an existing identity must never call this. Existing or unreadable
   * documents are always recovered, never replaced with an empty complete ledger. */
  initialize(sessionId: string): void {
    if (this.sessions.has(sessionId)) return
    if (
      this.storage.read(this.ledgerName(sessionId)) !== null ||
      this.storage.read(this.historyName(sessionId)) !== null
    ) {
      this.load(sessionId)
      return
    }
    const ledger: SessionLedger = { complete: true, entries: new Map(), history: new Map() }
    this.persist(sessionId, ledger)
    this.sessions.set(sessionId, ledger)
  }

  /**
   * The write arrives: the entry the ledger holds for the id, or `received`
   * written and persisted first. Throws when the phase cannot be persisted,
   * in which case nothing is held.
   */
  receive(sessionId: string, id: string): { held: LedgerEntry } | { first: true } {
    const ledger = this.load(sessionId)
    const evidenced = ledger.history.get(id)
    if (evidenced !== undefined) return { held: { status: 'accepted', at: evidenced } }
    const held = ledger.entries.get(id)
    if (held) return { held }
    if (!ledger.complete)
      return { held: { status: 'unknown', at: this.now(), reason: LEDGER_INCOMPLETE } }
    this.put(sessionId, ledger, id, { status: 'received', at: this.now() })
    return { first: true }
  }

  /** Immediately before the hand-off to the provider. Throws when it cannot
   *  be persisted; the caller then settles the entry as rejected. */
  dispatch(sessionId: string, id: string): void {
    const ledger = this.load(sessionId)
    this.put(sessionId, ledger, id, { status: 'dispatched', at: this.now() })
  }

  /** The provider took it. A persistence failure here is logged, not
   *  thrown: the message landed, and the history carries the id. */
  accept(sessionId: string, id: string, at = this.now()): LedgerEntry {
    const ledger = this.load(sessionId)
    const current = ledger.entries.get(id)
    const entry: LedgerEntry = current?.status === 'accepted' ? current : { status: 'accepted', at }
    this.put(sessionId, ledger, id, entry, { tolerate: true })
    return entry
  }

  /** A dispatch whose acknowledgement was lost must not authorize a retry. */
  unknown(sessionId: string, id: string, reason: string): void {
    const ledger = this.load(sessionId)
    this.put(
      sessionId,
      ledger,
      id,
      { status: 'unknown', at: this.now(), reason },
      { tolerate: true }
    )
  }

  /** The provider refused it, or the dispatch failed. */
  reject(sessionId: string, id: string, reason: string): LedgerEntry {
    const ledger = this.load(sessionId)
    const entry: LedgerEntry = { status: 'rejected', at: this.now(), reason }
    this.put(sessionId, ledger, id, entry, { tolerate: true })
    return entry
  }

  /**
   * A `user_message` carrying the id passed on the session's stream: the
   * server's own history records it, and an entry at `dispatched` or
   * `unknown` is settled as `accepted` by that evidence.
   */
  evidence(sessionId: string, id: string, at = this.now()): void {
    const ledger = this.load(sessionId)
    if (!ledger.history.has(id)) {
      ledger.history.set(id, at)
      try {
        this.storage.write(
          this.historyName(sessionId),
          JSON.stringify(this.historyDocument(ledger))
        )
      } catch (error) {
        this.log(`write history of session ${sessionId} not written: ${messageOf(error)}`)
      }
    }
    const entry = ledger.entries.get(id)
    if (entry && (entry.status === 'dispatched' || entry.status === 'unknown'))
      this.put(sessionId, ledger, id, { status: 'accepted', at }, { tolerate: true })
  }

  /** What became of the id, for `GET /sessions/writes`. */
  status(sessionId: string, id: string): WriteStatusView {
    let ledger: SessionLedger
    try {
      ledger = this.load(sessionId)
    } catch {
      return { status: 'unknown', reason: LEDGER_UNREADABLE }
    }
    const entry = ledger.entries.get(id)
    if (entry) return statusOf(entry)
    const evidenced = ledger.history.get(id)
    if (evidenced !== undefined) return { status: 'accepted', at: evidenced }
    return ledger.complete ? { status: 'absent' } : { status: 'unknown', reason: LEDGER_INCOMPLETE }
  }

  /** The entries of a session, for the tests. */
  entries(sessionId: string): ReadonlyMap<string, LedgerEntry> {
    return this.load(sessionId).entries
  }

  // ── The documents ──

  private ledgerName(sessionId: string): string {
    return `${ledgerFileStem(sessionId)}.ledger.json`
  }
  private historyName(sessionId: string): string {
    return `${ledgerFileStem(sessionId)}.history.json`
  }

  /** The session's ledger, from memory, else from disk with the recovery
   *  rules applied to what a previous process left. */
  private load(sessionId: string): SessionLedger {
    const loaded = this.sessions.get(sessionId)
    if (loaded) return loaded
    const history = this.readHistory(sessionId)
    const ledger: SessionLedger = { complete: false, entries: new Map(), history }
    let recovered = false
    let text: string | null
    try {
      text = this.storage.read(this.ledgerName(sessionId))
    } catch (error) {
      // Unreadable: kept as it is on disk, the ledger starts again incomplete.
      this.log(`write ledger of session ${sessionId} cannot be read: ${messageOf(error)}`)
      text = null
      ledger.complete = false
      recovered = true
    }
    if (text !== null) {
      const parsed = parseLedger(text)
      if (!parsed) {
        this.log(
          `write ledger of session ${sessionId} is not valid; put aside, started again incomplete`
        )
        try {
          this.storage.write(`${this.ledgerName(sessionId)}.unreadable-${this.now()}`, text)
        } catch {
          /* the copy is best effort */
        }
        ledger.complete = false
        recovered = true
      } else {
        ledger.complete = parsed.complete
        for (const [id, entry] of Object.entries(parsed.entries)) {
          // What a previous process left: the recovery rules.
          if (entry.status === 'received') {
            ledger.entries.set(id, {
              status: 'rejected',
              at: this.now(),
              reason: RESTARTED_BEFORE_DISPATCH
            })
            recovered = true
          } else if (entry.status === 'dispatched') {
            const evidenced = history.get(id)
            ledger.entries.set(
              id,
              evidenced !== undefined
                ? { status: 'accepted', at: evidenced }
                : { status: 'unknown', at: this.now(), reason: STOPPED_AFTER_DISPATCH }
            )
            recovered = true
          } else ledger.entries.set(id, entry)
        }
      }
    }
    this.sessions.set(sessionId, ledger)
    if (recovered) this.persist(sessionId, ledger, { tolerate: true })
    return ledger
  }

  private readHistory(sessionId: string): Map<string, number> {
    const items = new Map<string, number>()
    try {
      const text = this.storage.read(this.historyName(sessionId))
      if (text === null) return items
      const parsed = JSON.parse(text) as Partial<HistoryDocument>
      if (parsed.v === 1 && Array.isArray(parsed.items))
        for (const item of parsed.items)
          if (typeof item?.id === 'string' && typeof item.at === 'number')
            items.set(item.id, item.at)
    } catch (error) {
      this.log(`write history of session ${sessionId} cannot be read: ${messageOf(error)}`)
    }
    return items
  }

  private put(
    sessionId: string,
    ledger: SessionLedger,
    id: string,
    entry: LedgerEntry,
    options: { tolerate?: boolean } = {}
  ): void {
    const previous = ledger.entries.get(id)
    ledger.entries.set(id, entry)
    try {
      this.persist(sessionId, ledger)
    } catch (error) {
      if (!options.tolerate) {
        // Not persisted, not held: the write it would have recorded is refused.
        if (previous) ledger.entries.set(id, previous)
        else ledger.entries.delete(id)
        throw new Error(`the write ledger could not be written: ${messageOf(error)}`)
      }
      this.log(`write ledger of session ${sessionId} not written: ${messageOf(error)}`)
    }
  }

  private persist(
    sessionId: string,
    ledger: SessionLedger,
    options: { tolerate?: boolean } = {}
  ): void {
    const document: LedgerDocument = {
      v: 1,
      complete: ledger.complete,
      entries: Object.fromEntries(ledger.entries)
    }
    try {
      this.storage.write(this.ledgerName(sessionId), JSON.stringify(document))
    } catch (error) {
      if (!options.tolerate) throw error
      this.log(`write ledger of session ${sessionId} not written: ${messageOf(error)}`)
    }
  }

  private historyDocument(ledger: SessionLedger): HistoryDocument {
    return { v: 1, items: [...ledger.history].map(([id, at]) => ({ id, at })) }
  }
}

const STATUSES = new Set(['received', 'dispatched', 'accepted', 'rejected', 'unknown'])

/** The document when it is one of ours, null otherwise. */
function parseLedger(text: string): LedgerDocument | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const doc = parsed as Partial<LedgerDocument>
  if (doc.v !== 1 || typeof doc.complete !== 'boolean') return null
  if (typeof doc.entries !== 'object' || doc.entries === null || Array.isArray(doc.entries))
    return null
  for (const entry of Object.values(doc.entries)) {
    const e = entry as Partial<LedgerEntry> | null
    if (!e || !STATUSES.has(e.status as string) || typeof e.at !== 'number') return null
    if ((e.status === 'rejected' || e.status === 'unknown') && typeof e.reason !== 'string')
      return null
  }
  return { v: 1, complete: doc.complete, entries: doc.entries as Record<string, LedgerEntry> }
}

function statusOf(entry: LedgerEntry): WriteStatusView {
  switch (entry.status) {
    case 'received':
    case 'dispatched':
      return { status: 'pending' }
    case 'accepted':
      return { status: 'accepted', at: entry.at }
    case 'rejected':
      return { status: 'rejected', at: entry.at, reason: entry.reason }
    case 'unknown':
      return { status: 'unknown', at: entry.at, reason: entry.reason }
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** The documents as files under `dir` (owner-only, written then renamed). */
export function fileWriteLedgerStorage(
  dir: string,
  legacy?: { readonly activationFile: string; readonly sessionIds: ReadonlyArray<string> }
): WriteLedgerStorage {
  const target = (name: string): string => path.join(dir, name)
  const storage: WriteLedgerStorage = {
    read(name) {
      try {
        return fs.readFileSync(target(name), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    write(name, text) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = target(name)
      const tmp = `${file}.tmp`
      fs.rmSync(tmp, { force: true })
      fs.writeFileSync(tmp, text, { mode: 0o600 })
      fs.renameSync(tmp, file)
    }
  }
  if (legacy && !fs.existsSync(legacy.activationFile)) {
    // This runs before the API listener. Only a genuinely new ledger directory
    // proves these saved sessions predate identified writes. Existing storage,
    // even empty/corrupt, must never be relabelled as a legacy installation.
    const firstActivation = !fs.existsSync(dir)
    fs.mkdirSync(path.dirname(legacy.activationFile), { recursive: true, mode: 0o700 })
    // Record activation outside the ledger directory BEFORE initializing ids.
    // A crash part-way through, or loss of the entire ledger directory later,
    // cannot cause another migration to claim missing entries are absent.
    fs.writeFileSync(legacy.activationFile, JSON.stringify({ v: 1 }), { mode: 0o600, flag: 'wx' })
    if (firstActivation) {
      const ledger = new WriteLedger(storage)
      for (const id of new Set(legacy.sessionIds)) ledger.initialize(id)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
  }
  return storage
}

/** The documents in memory, for the tests and for a server with no data directory. */
export function memoryWriteLedgerStorage(): WriteLedgerStorage & {
  readonly documents: Map<string, string>
} {
  const documents = new Map<string, string>()
  return {
    documents,
    read: (name) => documents.get(name) ?? null,
    write: (name, text) => {
      documents.set(name, text)
    }
  }
}

/** The ledger as a service of the server, one per server instance. */
export class SessionWrites extends Context.Tag('@clave/server/SessionWrites')<
  SessionWrites,
  WriteLedger
>() {
  static layer(storage: WriteLedgerStorage): Layer.Layer<SessionWrites> {
    return Layer.sync(SessionWrites, () => new WriteLedger(storage))
  }
  /** A ledger that lives as long as the process: a server given no storage. */
  static readonly memory: Layer.Layer<SessionWrites> = Layer.sync(
    SessionWrites,
    () => new WriteLedger(memoryWriteLedgerStorage())
  )
}
