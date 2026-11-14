/**
 * OpenCode's records per session (PRDCT-4551), read through the program's
 * own documented commands and never copied. OpenCode 2.3.0 keeps tokens and
 * cost per message in its own store; two of its commands give them, checked
 * on the real program on 14 November 2026 against a stand-in endpoint:
 *
 *  - `opencode api --standalone GET /api/session?limit=…&order=desc` lists
 *    the sessions of EVERY project (newest 50 by default; `cursor` pages),
 *    each with `time.updated`; `opencode session list` lists the current
 *    project's alone, so it is not the one read;
 *  - `opencode session export --standalone <id>` answers the session's
 *    messages, each assistant message with `model.providerID`, `tokens`
 *    (`input`, `output`, `reasoning`, `cache.read`, `cache.write`), `cost`
 *    and `time`.
 *
 * `--standalone` on both: without it the command reaches (or starts) the
 * person's background service; a private server reads the same store and
 * leaves the service alone. A session is exported again only when its
 * `time.updated` changed, as `pi-usage.ts` reads a file again only when it
 * changed. The session's own `tokens` total also counts calls that are no
 * message (its title's): only messages are records, one request each.
 */

export interface OpencodeSessionRecord {
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

/** Runs `opencode <args>` and answers its standard output; rejects on a
 *  failure, a non-zero exit or the timeout. */
export type OpencodeRun = (args: string[], timeoutMs: number) => Promise<string>

interface ListedSession {
  id: string
  updated: number
  parentId: string | null
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const PAGE = 200
const MAX_PAGES = 50
const LIST_TIMEOUT_MS = 20_000
const EXPORT_TIMEOUT_MS = 20_000

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** One page of `GET /api/session`: its sessions and the next cursor. */
export function parseSessionPage(text: string): { sessions: ListedSession[]; next: string | null } {
  const body = obj(JSON.parse(text))
  const data = Array.isArray(body?.data) ? body.data : []
  const sessions: ListedSession[] = []
  for (const raw of data) {
    const s = obj(raw)
    if (!s || typeof s.id !== 'string' || !SESSION_ID.test(s.id)) continue
    const time = obj(s.time)
    const parent =
      typeof s.parentID === 'string'
        ? s.parentID
        : typeof s.parentId === 'string'
          ? s.parentId
          : null
    sessions.push({
      id: s.id,
      updated: num(time?.updated) || num(time?.created),
      parentId: parent && SESSION_ID.test(parent) ? parent : null
    })
  }
  const next = obj(body?.cursor)?.next
  return { sessions, next: typeof next === 'string' && next ? next : null }
}

/**
 * The records of one `session export`: one per assistant message, at its
 * completion (else its creation), under the provider OpenCode names its
 * model by. OpenCode counts reasoning apart from output: both are output
 * here, and the total is every token the call moved, cache included, as
 * Pi's `totalTokens` is.
 */
export function parseSessionExport(text: string): {
  sessionId: string | null
  records: Omit<OpencodeSessionRecord, 'sessionId'>[]
} {
  const body = obj(JSON.parse(text))
  const info = obj(body?.info)
  const sessionId = typeof info?.id === 'string' ? info.id : null
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const records: Omit<OpencodeSessionRecord, 'sessionId'>[] = []
  for (const raw of messages) {
    const m = obj(raw)
    if (!m || m.type !== 'assistant') continue
    const tokens = obj(m.tokens)
    if (!tokens) continue
    const cache = obj(tokens.cache)
    const time = obj(m.time)
    const at = num(time?.completed) || num(time?.created)
    if (!at) continue
    const model = obj(m.model)
    const input = num(tokens.input)
    const output = num(tokens.output) + num(tokens.reasoning)
    const cacheRead = num(cache?.read)
    const cacheWrite = num(cache?.write)
    records.push({
      at,
      provider: typeof model?.providerID === 'string' ? model.providerID : null,
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: num(m.cost)
    })
  }
  return { sessionId, records }
}

export class OpencodeSessionRecords {
  private readonly cache = new Map<string, { updated: number; records: OpencodeSessionRecord[] }>()

  constructor(
    private readonly run: OpencodeRun,
    private readonly concurrency = 4
  ) {}

  /** Every session's records, read again for the sessions updated at or
   *  after `since` whose `time.updated` changed. A child session (a
   *  subagent's) is counted as its root session: the ledger knows the root. */
  async read(since: number): Promise<OpencodeSessionRecord[]> {
    const listed = await this.list()
    const parents = new Map(listed.map((s) => [s.id, s.parentId]))
    const rootOf = (id: string): string => {
      let current = id
      for (let i = 0; i < 16; i++) {
        const parent = parents.get(current)
        if (!parent) return current
        current = parent
      }
      return current
    }
    const stale = listed.filter((s) => {
      if (s.updated < since) return false
      return this.cache.get(s.id)?.updated !== s.updated
    })
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < stale.length) {
        const session = stale[next++]
        try {
          const out = await this.run(
            ['session', 'export', '--standalone', session.id],
            EXPORT_TIMEOUT_MS
          )
          const parsed = parseSessionExport(out)
          this.cache.set(session.id, {
            updated: session.updated,
            records: parsed.records.map((r) => ({ ...r, sessionId: session.id }))
          })
        } catch {
          // One session that cannot be exported is skipped, the rest counted.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, this.concurrency) }, worker))
    const out: OpencodeSessionRecord[] = []
    for (const session of listed) {
      const cached = this.cache.get(session.id)
      if (!cached) continue
      const root = rootOf(session.id)
      for (const record of cached.records) out.push({ ...record, sessionId: root })
    }
    return out
  }

  private async list(): Promise<ListedSession[]> {
    const out = new Map<string, ListedSession>()
    let cursor: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = `limit=${PAGE}&order=desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const text = await this.run(
        ['api', '--standalone', 'GET', `/api/session?${query}`],
        LIST_TIMEOUT_MS
      )
      const { sessions, next } = parseSessionPage(text)
      let added = 0
      for (const s of sessions)
        if (!out.has(s.id)) {
          out.set(s.id, s)
          added++
        }
      if (!next || added === 0 || sessions.length < PAGE) break
      cursor = next
    }
    return [...out.values()]
  }
}
