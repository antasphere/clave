import type { ActivityRow } from '../../shared/activity-model'
import type { AgentState, Session } from '../../shared/session-model'
import { ActivityStore } from './store'

/**
 * The activity recorder (PRDCT-3384): the main-process writer of the
 * activity ledger. It listens to the session manager (every adoption, every
 * state transition, every forget, whichever transport and whichever window)
 * and appends one row per event; it stamps `alive.json` every minute while
 * the app runs; at boot it closes the previous run when that run never wrote
 * its own quit (a crash, a kill) with a synthetic quit at the alive stamp;
 * and at quit it writes the quit row and goes silent, so the forgets the
 * shutdown produces never read as closes.
 *
 * No Electron imports: the store's directory, the manager's hooks and the
 * clock are injected, so the recorder is testable outside the app and runs
 * under a server of its own.
 */
export interface RecorderSource {
  subscribeAdded(cb: (session: Session, meta: { model: string | null }) => void): () => void
  subscribeState(cb: (id: string, state: AgentState) => void): () => void
  subscribeRemoved(cb: (id: string) => void): () => void
  /** The session's current record, for the name a close row keeps. */
  get(id: string): Session | undefined
}

export interface RecorderOptions {
  now?: () => number
  /** The alive stamp's period; 60 s in the app. */
  aliveMs?: number
  /** Called after every row written (the live push). */
  onRow?: (row: ActivityRow) => void
  /** The error sink; the recorder never throws into the manager. */
  onError?: (error: unknown) => void
}

export class ActivityRecorder {
  readonly store: ActivityStore
  private readonly now: () => number
  private readonly aliveMs: number
  private readonly onRow?: (row: ActivityRow) => void
  private readonly onError: (error: unknown) => void
  private rows: ActivityRow[] = []
  /** Lines of the file that were not rows, counted at load. */
  skippedLines = 0
  private offs: (() => void)[] = []
  private aliveTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(dir: string, options: RecorderOptions = {}) {
    this.store = new ActivityStore(dir)
    this.now = options.now ?? (() => Date.now())
    this.aliveMs = options.aliveMs ?? 60_000
    this.onRow = options.onRow
    this.onError = options.onError ?? ((e) => console.error('[activity] write failed', e))
  }

  /** Every row known, the file's plus this run's, in append order. */
  all(): ActivityRow[] {
    return this.rows
  }

  /** Load the file, close a run that never quit, write this run's start,
   *  subscribe to the manager, and start the alive stamp. */
  start(source: RecorderSource): void {
    const read = this.store.readAll()
    this.rows = read.rows
    this.skippedLines = read.skippedLines
    this.closePreviousRun()
    this.write({ v: 1, ts: this.iso(), kind: 'app', app: 'start' })
    this.offs.push(
      source.subscribeAdded((session, meta) => {
        this.write({
          v: 1,
          ts: this.iso(),
          kind: 'open',
          id: session.id,
          provider: session.provider,
          cwd: session.cwd,
          name: session.title,
          model: meta.model
        })
      }),
      source.subscribeState((id, state) => {
        this.write({ v: 1, ts: this.iso(), kind: 'state', id, state })
      }),
      source.subscribeRemoved((id) => {
        const record = source.get(id)
        this.write({
          v: 1,
          ts: this.iso(),
          kind: 'close',
          id,
          ...(record?.title ? { name: record.title } : {})
        })
      })
    )
    this.stampAlive()
    this.aliveTimer = setInterval(() => this.stampAlive(), this.aliveMs)
    this.aliveTimer.unref?.()
  }

  /** The app is quitting: the quit row, then silence. Idempotent. */
  quit(): void {
    if (this.stopped) return
    this.write({ v: 1, ts: this.iso(), kind: 'app', app: 'quit' })
    this.stop()
  }

  /** Unsubscribe and stop stamping without writing a quit (tests, a handover). */
  stop(): void {
    this.stopped = true
    for (const off of this.offs) off()
    this.offs = []
    if (this.aliveTimer) clearInterval(this.aliveTimer)
    this.aliveTimer = null
  }

  private closePreviousRun(): void {
    let lastApp: ActivityRow | null = null
    for (const r of this.rows) if (r.kind === 'app') lastApp = r
    if (this.rows.length === 0 || (lastApp && lastApp.app === 'quit')) return
    // The previous run ended without a quit row: at the alive stamp when it
    // is later than the last row, else at the last row itself. Never in the
    // future of now.
    const lastRowTs = Date.parse(this.rows[this.rows.length - 1].ts)
    const alive = this.store.readAlive()
    const aliveTs = alive ? Date.parse(alive) : NaN
    const at = Math.min(
      this.now(),
      Math.max(lastRowTs, Number.isNaN(aliveTs) ? lastRowTs : aliveTs)
    )
    this.write({ v: 1, ts: new Date(at).toISOString(), kind: 'app', app: 'quit', synthetic: true })
  }

  private stampAlive(): void {
    try {
      this.store.writeAlive(this.iso())
    } catch (e) {
      this.onError(e)
    }
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  private write(row: ActivityRow): void {
    if (this.stopped) return
    try {
      this.store.append(row)
      this.rows.push(row)
      this.onRow?.(row)
    } catch (e) {
      this.onError(e)
    }
  }
}
