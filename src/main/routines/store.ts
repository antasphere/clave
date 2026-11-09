/**
 * The routines store (ADR 0004): `routines.json` under the server's data
 * directory, through the storage port, written whole and atomically on
 * every change. Per routine key: the scheduler's clock (`lastConsideredAt`,
 * the schedule last seen, when the routine was first and last seen) and the
 * last `KEEP_RUNS` runs, newest first. The viewer's port is kept here too,
 * so the next start asks for the same one. Routines absent from the files
 * for `PRUNE_AFTER_MS` are forgotten, their deck folders with them
 * (the service removes the folders; the store only says which).
 */
import type { RoutineRun } from '@clave/contract/routines'
import type { StoragePort } from '../ports/storage'

export const STORE_FILE = 'routines.json'
export const KEEP_RUNS = 20
export const PRUNE_AFTER_MS = 30 * 86_400_000

export interface RoutineState {
  lastConsideredAt: number | null
  schedule: string | null
  firstSeenAt: number
  lastSeenAt: number
  runs: RoutineRun[]
  /** The routine's deck on Slideless (PRDCT-4149): one deck per routine, a
   *  version per run, and the one named share link minted for it (a bearer
   *  URL, kept here under the server's own data and nowhere else). */
  publish?: RoutinePublishState | null
}

export interface RoutinePublishState {
  deckId: string
  share: { tokenId: string; url: string } | null
}

export interface RoutinesDocument {
  version: 1
  viewerPort: number | null
  routines: Record<string, RoutineState>
}

const EMPTY: RoutinesDocument = { version: 1, viewerPort: null, routines: {} }

export class RoutinesStore {
  private cache: RoutinesDocument | null = null
  constructor(
    private readonly storage: Pick<StoragePort, 'read' | 'write'>,
    private readonly now: () => number = () => Date.now()
  ) {}

  private load(): RoutinesDocument {
    if (this.cache) return this.cache
    const raw = this.storage.read(STORE_FILE)
    let parsed: unknown = null
    try {
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      parsed = null
    }
    const doc =
      parsed && typeof parsed === 'object' && (parsed as { version?: unknown }).version === 1
        ? (parsed as RoutinesDocument)
        : { ...EMPTY, routines: {} }
    this.cache = {
      version: 1,
      viewerPort: typeof doc.viewerPort === 'number' ? doc.viewerPort : null,
      routines: doc.routines && typeof doc.routines === 'object' ? doc.routines : {}
    }
    return this.cache
  }

  private save(): void {
    this.storage.write(STORE_FILE, JSON.stringify(this.load(), null, 2))
  }

  document(): RoutinesDocument {
    return this.load()
  }

  state(key: string): RoutineState | undefined {
    return this.load().routines[key]
  }

  /** The routine was seen in the files at this tick: created when new. */
  seen(key: string): RoutineState {
    const doc = this.load()
    const now = this.now()
    const state = (doc.routines[key] ??= {
      lastConsideredAt: null,
      schedule: null,
      firstSeenAt: now,
      lastSeenAt: now,
      runs: []
    })
    state.lastSeenAt = now
    return state
  }

  /** The clock after a tick: considered up to `at`, under `schedule`. */
  considered(key: string, at: number, schedule: string): void {
    const state = this.seen(key)
    state.lastConsideredAt = at
    state.schedule = schedule
    this.save()
  }

  /** A run added in front; the oldest beyond `KEEP_RUNS` go. */
  addRun(run: RoutineRun): void {
    const state = this.seen(run.routineKey)
    state.runs = [run, ...state.runs.filter((r) => r.id !== run.id)].slice(0, KEEP_RUNS)
    this.save()
  }

  updateRun(runId: string, patch: Partial<RoutineRun>): RoutineRun | undefined {
    const doc = this.load()
    for (const state of Object.values(doc.routines)) {
      const at = state.runs.findIndex((r) => r.id === runId)
      if (at >= 0) {
        state.runs[at] = { ...state.runs[at], ...patch }
        this.save()
        return state.runs[at]
      }
    }
    return undefined
  }

  run(runId: string): RoutineRun | undefined {
    for (const state of Object.values(this.load().routines))
      for (const run of state.runs) if (run.id === runId) return run
    return undefined
  }

  runBySession(sessionId: string): RoutineRun | undefined {
    for (const state of Object.values(this.load().routines))
      for (const run of state.runs)
        if (run.sessionId === sessionId || run.discussionSessionId === sessionId) return run
    return undefined
  }

  /** Every run still in flight or waiting: what a start must finish off. */
  openRuns(): RoutineRun[] {
    const out: RoutineRun[] = []
    for (const state of Object.values(this.load().routines))
      for (const run of state.runs)
        if (run.state === 'running' || run.state === 'waiting') out.push(run)
    return out
  }

  /** Forget the routines not seen for `PRUNE_AFTER_MS`; answers their keys. */
  prune(live: ReadonlySet<string>): string[] {
    const doc = this.load()
    const cutoff = this.now() - PRUNE_AFTER_MS
    const gone: string[] = []
    for (const [key, state] of Object.entries(doc.routines)) {
      if (live.has(key)) continue
      if (state.lastSeenAt < cutoff) {
        delete doc.routines[key]
        gone.push(key)
      }
    }
    if (gone.length) this.save()
    return gone
  }

  publishState(key: string): RoutinePublishState | null {
    return this.load().routines[key]?.publish ?? null
  }

  setPublishState(key: string, state: RoutinePublishState | null): void {
    const current = this.seen(key)
    current.publish = state
    this.save()
  }

  viewerPort(): number | null {
    return this.load().viewerPort
  }

  setViewerPort(port: number): void {
    this.load().viewerPort = port
    this.save()
  }
}
