import type { ActivityRow } from '../../shared/activity-model'
import type { AgentState } from '../../shared/session-model'

/**
 * The one-time backfill (PRDCT-3384): the two traces Clave wrote before the
 * activity ledger existed, folded into activity rows up to `now`.
 *
 * - The exchange-capture stream (`exchange-capture/events.jsonl`): one
 *   `session_state` per transition of an agent tab (working, idle, blocked,
 *   exited), one `tab_closed` per close, each with the tab's identity.
 * - The session ledger (`session-history/ledger.jsonl`): `placed` and `closed`
 *   rows for EVERY tab, plain terminals included, with the tab's mode.
 *
 * Both key a tab by the same Clave session id, so the two are merged per tab:
 * the open is the earliest row seen, the close the first close seen. A tab
 * with no close at all is closed at its last row, plus six hours when that
 * row left it working: the app quit or crashed somewhere after, and six
 * hours is the ceiling a working burst could honestly have reached.
 *
 * No Electron imports and no file reads: the caller hands the parsed lines.
 */
export interface CaptureLine {
  kind?: unknown
  ts?: unknown
  state?: unknown
  session?: unknown
}

export interface LedgerLine {
  kind?: unknown
  ts?: unknown
  sessionId?: unknown
  name?: unknown
  cwd?: unknown
  mode?: unknown
  model?: unknown
}

const SIX_HOURS = 6 * 3_600_000

interface Tab {
  id: string
  provider: string
  cwd: string
  name: string
  model: string | null
  firstTs: number
  lastTs: number
  lastState: AgentState | null
  events: { t: number; row: ActivityRow }[]
  closed: number | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

const CAPTURE_STATE: Record<string, AgentState> = {
  working: 'working',
  idle: 'idle',
  blocked: 'blocked',
  exited: 'ended'
}

export function backfillRows(
  capture: CaptureLine[],
  ledger: LedgerLine[],
  now: number
): { rows: ActivityRow[]; sessions: number } {
  const tabs = new Map<string, Tab>()
  const tab = (
    id: string,
    t: number,
    identity: {
      provider?: string | null
      cwd?: string | null
      name?: string | null
      model?: unknown
    }
  ): Tab => {
    let existing = tabs.get(id)
    if (!existing) {
      existing = {
        id,
        provider: identity.provider ?? 'terminal',
        cwd: identity.cwd ?? '',
        name: identity.name ?? '',
        model: typeof identity.model === 'string' ? identity.model : null,
        firstTs: t,
        lastTs: t,
        lastState: null,
        events: [],
        closed: null
      }
      tabs.set(id, existing)
    } else {
      if (t < existing.firstTs) existing.firstTs = t
      if (identity.name) existing.name = identity.name
      if (identity.cwd && !existing.cwd) existing.cwd = identity.cwd
      if (typeof identity.model === 'string' && !existing.model) existing.model = identity.model
    }
    if (t > existing.lastTs) existing.lastTs = t
    return existing
  }

  for (const line of capture) {
    const kind = str(line.kind)
    const ts = str(line.ts)
    if (!kind || !ts) continue
    const t = Date.parse(ts)
    if (Number.isNaN(t) || t > now) continue
    const session = line.session as Record<string, unknown> | undefined
    const id = session ? str(session.sessionId) : null
    if (!id) continue
    const identity = {
      provider: session ? str(session.mode) : null,
      cwd: session ? str(session.cwd) : null,
      name: session ? str(session.name) : null,
      model: session?.model
    }
    if (kind === 'session_state') {
      const state = CAPTURE_STATE[str(line.state) ?? '']
      if (!state) continue
      const tb = tab(id, t, identity)
      tb.events.push({ t, row: { v: 1, ts, kind: 'state', id, state, source: 'backfill' } })
      tb.lastState = state
    } else if (kind === 'tab_closed') {
      const tb = tab(id, t, identity)
      if (tb.closed === null || t < tb.closed) tb.closed = t
    }
  }
  for (const line of ledger) {
    const kind = str(line.kind)
    const ts = str(line.ts)
    const id = str(line.sessionId)
    if (!kind || !ts || !id) continue
    const t = Date.parse(ts)
    if (Number.isNaN(t) || t > now) continue
    const identity = {
      provider: str(line.mode),
      cwd: str(line.cwd),
      name: str(line.name),
      model: line.model
    }
    const tb = tab(id, t, identity)
    if (kind === 'closed' && (tb.closed === null || t < tb.closed)) tb.closed = t
  }

  const rows: ActivityRow[] = []
  for (const tb of tabs.values()) {
    rows.push({
      v: 1,
      ts: new Date(tb.firstTs).toISOString(),
      kind: 'open',
      id: tb.id,
      provider: tb.provider,
      cwd: tb.cwd,
      name: tb.name,
      model: tb.model,
      source: 'backfill'
    })
    // State words after the close are the trace's own noise; keep the ones
    // inside the span.
    const closeAt =
      tb.closed ??
      Math.min(
        now,
        tb.lastTs + (tb.lastState === 'working' || tb.lastState === 'blocked' ? SIX_HOURS : 0)
      )
    for (const ev of tb.events) if (ev.t <= closeAt) rows.push(ev.row)
    rows.push({
      v: 1,
      ts: new Date(closeAt).toISOString(),
      kind: 'close',
      id: tb.id,
      name: tb.name,
      source: 'backfill'
    })
  }
  rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  return { rows, sessions: tabs.size }
}
