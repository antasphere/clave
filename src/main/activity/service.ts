import { app, BrowserWindow } from 'electron'
import * as path from 'path'
import { sessionManager } from '../sessions/session-manager'
import { ActivityRecorder } from './recorder'
import { backfillRows } from './backfill'
import { CaptureStore } from '../exchange-capture/store'
import { SessionLedger } from '../session-history/ledger'
import {
  foldActivity,
  localDayKey,
  localDayStart,
  type DayActivity
} from '../../shared/activity-fold'
import type { ActivityRow } from '../../shared/activity-model'

/**
 * The activity record's owner in the app: one recorder over the session
 * manager, started with the IPC handlers, quit from `before-quit`; the
 * one-time backfill at the first boot; the fold answered to the windows and
 * a throttled `activity:changed` pushed to every window when a row lands.
 * The record lives under `<userData>/activity/` and never leaves the machine.
 */
let recorder: ActivityRecorder | null = null
let pushTimer: ReturnType<typeof setTimeout> | null = null
const CHANGED_CHANNEL = 'activity:changed'
const PUSH_DELAY_MS = 1500

function userData(name: string): string {
  return path.join(app.getPath('userData'), name)
}

function pushChanged(): void {
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send(CHANGED_CHANNEL)
  }, PUSH_DELAY_MS)
  pushTimer.unref?.()
}

/** Start recording. Idempotent; the first call runs the backfill when the
 *  record does not exist yet. */
export function startActivityRecord(): ActivityRecorder {
  if (recorder) return recorder
  const rec = new ActivityRecorder(userData('activity'), { onRow: () => pushChanged() })
  recorder = rec
  const fresh = !rec.store.exists() && !rec.store.isBackfilled()
  if (fresh) {
    try {
      const capture = new CaptureStore(userData('exchange-capture')).readAll().events
      const ledger = new SessionLedger(userData('session-history')).readAll().rows
      const { rows, sessions } = backfillRows(capture, ledger, Date.now())
      rec.store.appendMany(rows)
      rec.store.markBackfilled({ at: new Date().toISOString(), rows: rows.length, sessions })
      console.log(`[activity] backfilled ${rows.length} rows from ${sessions} past sessions`)
    } catch (e) {
      console.error('[activity] backfill failed; recording starts empty', e)
    }
  }
  rec.start({
    subscribeAdded: (cb) =>
      sessionManager.subscribeAdded((session, meta) => cb(session, { model: meta.model ?? null })),
    subscribeState: (cb) =>
      sessionManager.subscribeAll((id, stream) => {
        if (stream.kind === 'event' && stream.event.type === 'state_change')
          cb(id, stream.event.state)
      }),
    subscribeRemoved: (cb) => sessionManager.subscribeRemoved(cb),
    get: (id) => sessionManager.get(id)
  })
  return rec
}

/** The quit row; safe to call without a recorder. */
export function quitActivityRecord(): void {
  recorder?.quit()
}

export interface ActivityQuery {
  from: string
  to: string
  /** Per-minute arrays wanted (one day for the tape); false for a range's totals. */
  detail?: boolean
}

export interface ActivityAnswer {
  days: DayActivity[]
  now: number
  skipped: number
  file: string
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

/** A real local day: the shape, and a round trip through the calendar (a
 *  13th month or a 45th day would otherwise be answered as some later day). */
function isDayKey(key: unknown): key is string {
  return typeof key === 'string' && DAY_KEY.test(key) && localDayKey(localDayStart(key)) === key
}

/** The fold over the rows in memory, for a local day range (inclusive). A
 *  live session's name is the manager's current title, so a tab renamed
 *  since it opened reads under its name. */
export function queryActivity(query: ActivityQuery): ActivityAnswer {
  if (!isDayKey(query.from) || !isDayKey(query.to)) throw new Error('Invalid day range')
  const rec = startActivityRecord()
  const now = Date.now()
  const rows: ActivityRow[] = rec.all()
  const days = foldActivity(rows, query.from, query.to, now, query.detail !== false)
  const titles = new Map(sessionManager.list().map((s) => [s.id, s.title]))
  for (const day of days)
    for (const s of day.sessions) {
      const title = s.live ? titles.get(s.id) : undefined
      if (title) s.name = title
    }
  return { days, now, skipped: rec.skippedLines, file: rec.store.filePath() }
}
