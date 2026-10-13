import * as fs from 'fs'
import * as path from 'path'
import { normalizeActivityRow, type ActivityRow } from '../../shared/activity-model'

/**
 * The activity ledger on disk: `<dir>/activity.jsonl`, append-only, one row
 * per line, never rewritten; beside it `alive.json`, the stamp the recorder
 * rewrites every minute so the next boot knows when a crashed app was last
 * seen, and `backfilled.json`, the marker that the two older traces were
 * folded in once. No Electron imports: the directory is injected, so the
 * store is testable outside the app.
 */
export class ActivityStore {
  readonly dir: string
  private readonly file: string

  constructor(dir: string) {
    this.dir = dir
    this.file = path.join(dir, 'activity.jsonl')
  }

  filePath(): string {
    return this.file
  }

  exists(): boolean {
    return fs.existsSync(this.file)
  }

  append(row: ActivityRow): void {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n', 'utf-8')
  }

  appendMany(rows: ActivityRow[]): void {
    if (rows.length === 0) return
    fs.mkdirSync(this.dir, { recursive: true })
    fs.appendFileSync(this.file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
  }

  /** Every well-formed row in file order; malformed lines are counted. */
  readAll(): { rows: ActivityRow[]; skippedLines: number } {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf-8')
    } catch {
      return { rows: [], skippedLines: 0 }
    }
    const rows: ActivityRow[] = []
    let skippedLines = 0
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        skippedLines++
        continue
      }
      const row = normalizeActivityRow(parsed)
      if (row) rows.push(row)
      else skippedLines++
    }
    return { rows, skippedLines }
  }

  /** The alive stamp: when the running app last said it was alive. */
  writeAlive(ts: string): void {
    fs.mkdirSync(this.dir, { recursive: true })
    const target = path.join(this.dir, 'alive.json')
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ ts }), 'utf-8')
    fs.renameSync(tmp, target)
  }

  readAlive(): string | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, 'alive.json'), 'utf-8'))
      const ts = parsed && typeof parsed.ts === 'string' ? parsed.ts : null
      return ts && !Number.isNaN(Date.parse(ts)) ? ts : null
    } catch {
      return null
    }
  }

  isBackfilled(): boolean {
    return fs.existsSync(path.join(this.dir, 'backfilled.json'))
  }

  markBackfilled(info: { at: string; rows: number; sessions: number }): void {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(path.join(this.dir, 'backfilled.json'), JSON.stringify(info), 'utf-8')
  }
}
