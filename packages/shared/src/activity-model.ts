/**
 * The activity record (PRDCT-3384): what Clave remembers of when its sessions
 * ran. One append-only JSON Lines file under the app's data folder,
 * `activity/activity.jsonl`, one row per event, written by the main process
 * alone (`main/activity/recorder.ts`) from the session manager's own stream,
 * so every transport and every window land in the same file.
 *
 * Four kinds of row:
 *   `open`   a session the manager adopted (its provider, folder, name, model)
 *   `state`  a run-state transition of that session (working, idle, blocked,
 *            done, ended), the raw word as the manager holds it
 *   `close`  the manager forgot the session (closed, or re-homed at quit)
 *   `app`    the app itself started or quit; a quit written at the next boot
 *            from the alive stamp when the app did not get to write its own
 *            carries `synthetic: true`
 *
 * Rows folded in from the two older traces at the first boot carry
 * `source: 'backfill'` (`main/activity/backfill.ts`). The record never leaves
 * the machine: it is not telemetry, and nothing reads it but the Activity
 * page through `activity-fold.ts`.
 */
import type { AgentState } from './session-model'

export const ACTIVITY_ROW_VERSION = 1 as const

export type ActivityRowKind = 'open' | 'state' | 'close' | 'app'
export type ActivityAppEvent = 'start' | 'quit'
export type ActivityRowSource = 'live' | 'backfill'

export interface ActivityRow {
  v: typeof ACTIVITY_ROW_VERSION
  /** Producer-side ISO timestamp. */
  ts: string
  kind: ActivityRowKind
  /** The session's Clave id; absent on an `app` row. */
  id?: string
  /** On a `state` row. */
  state?: AgentState
  /** On an `open` row (and on a `close` row, the last known name). */
  provider?: string
  cwd?: string
  name?: string
  model?: string | null
  /** On an `app` row. */
  app?: ActivityAppEvent
  synthetic?: boolean
  source?: ActivityRowSource
}

const KINDS: ReadonlySet<string> = new Set<ActivityRowKind>(['open', 'state', 'close', 'app'])
const STATES: ReadonlySet<string> = new Set<AgentState>([
  'idle',
  'working',
  'blocked',
  'done',
  'ended'
])
const APP_EVENTS: ReadonlySet<string> = new Set<ActivityAppEvent>(['start', 'quit'])
const NAME_MAX = 512
const CWD_MAX = 4096

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/** Re-pick a row field by field from a parsed line. Returns null when a
 *  required field is missing or malformed, so one bad line never poisons the
 *  fold; the reader counts it. */
export function normalizeActivityRow(input: unknown): ActivityRow | null {
  if (!input || typeof input !== 'object') return null
  const r = input as Record<string, unknown>
  const kind = str(r.kind)
  const ts = str(r.ts)
  if (!kind || !KINDS.has(kind)) return null
  if (!ts || Number.isNaN(Date.parse(ts))) return null
  const row: ActivityRow = { v: ACTIVITY_ROW_VERSION, ts, kind: kind as ActivityRowKind }
  if (kind === 'app') {
    const app = str(r.app)
    if (!app || !APP_EVENTS.has(app)) return null
    row.app = app as ActivityAppEvent
    if (r.synthetic === true) row.synthetic = true
  } else {
    const id = str(r.id)
    if (!id) return null
    row.id = id
    if (kind === 'state') {
      const state = str(r.state)
      if (!state || !STATES.has(state)) return null
      row.state = state as AgentState
    } else {
      const provider = str(r.provider)
      const cwd = str(r.cwd)
      const name = str(r.name)
      if (provider) row.provider = provider
      if (cwd !== null) row.cwd = cwd.length > CWD_MAX ? cwd.slice(0, CWD_MAX) : cwd
      if (name !== null) row.name = name.length > NAME_MAX ? name.slice(0, NAME_MAX) : name
      if (r.model === null) row.model = null
      else if (typeof r.model === 'string') row.model = r.model
    }
  }
  if (r.source === 'backfill') row.source = 'backfill'
  return row
}

/** Providers whose run state Clave knows. Pi and plain terminals open and
 *  close only: their spans are drawn, never counted as working. */
export const TRACKED_PROVIDERS: ReadonlySet<string> = new Set([
  'claude',
  'claude-agents',
  'codex',
  'echo'
])

export function isTrackedProvider(provider: string | undefined): boolean {
  return provider !== undefined && TRACKED_PROVIDERS.has(provider)
}
