import fs from 'fs'
import path from 'path'
import type { DigestDone } from '../shared/exchange-digest'

/**
 * Where the exchange digests are kept once read: one JSON file in Clave's
 * data folder, the digests filed by the tab's session id and, within it, by
 * the key of the messages they read (`digestKey`). A digest is a model call
 * of some seconds and some cost, so it is read once: the timeline that shows
 * it, a remount, a restart, both views of the tab all find it here.
 *
 * Robust the way the app's other small stores are: written whole to a
 * temporary file and renamed over the old one, so a crash mid-write never
 * leaves half a file; a file that cannot be read is set aside and the store
 * starts empty rather than failing every call; writes are gathered for a
 * moment so a burst of digests is one write. Bounded: a session keeps its
 * latest PER_SESSION digests, and the store its latest SESSIONS sessions.
 */

const PER_SESSION = 40
const SESSIONS = 300
const SAVE_DELAY_MS = 400

interface Filed {
  at: number
  digest: DigestDone
}
type Shape = Record<string, Record<string, Filed>>

export class DigestStore {
  private data: Shape | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly file: string) {}

  private load(): Shape {
    if (this.data) return this.data
    try {
      const raw = fs.readFileSync(this.file, 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      this.data =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Shape) : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Unreadable: keep it aside for a look, start clean.
        try {
          fs.renameSync(this.file, `${this.file}.unreadable-${Date.now()}`)
        } catch {
          /* nothing to set aside */
        }
      }
      this.data = {}
    }
    return this.data
  }

  /** Every digest filed for a session, by key. */
  of(sessionId: string): Record<string, DigestDone> {
    const filed = this.load()[sessionId] ?? {}
    return Object.fromEntries(Object.entries(filed).map(([key, f]) => [key, f.digest]))
  }

  get(sessionId: string, key: string): DigestDone | undefined {
    return this.load()[sessionId]?.[key]?.digest
  }

  put(sessionId: string, key: string, digest: DigestDone): void {
    const data = this.load()
    const filed = (data[sessionId] ??= {})
    filed[key] = { at: Date.now(), digest }
    const keys = Object.keys(filed)
    if (keys.length > PER_SESSION)
      for (const old of keys
        .sort((a, b) => filed[a].at - filed[b].at)
        .slice(0, keys.length - PER_SESSION))
        delete filed[old]
    const sessions = Object.keys(data)
    if (sessions.length > SESSIONS) {
      const latest = (id: string): number =>
        Math.max(0, ...Object.values(data[id]).map((f) => f.at))
      for (const old of sessions
        .sort((a, b) => latest(a) - latest(b))
        .slice(0, sessions.length - SESSIONS))
        delete data[old]
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, SAVE_DELAY_MS)
  }

  /** Write now: the quit's call, and the tests'. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.data) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(this.data))
      fs.renameSync(tmp, this.file)
    } catch (error) {
      console.warn('[exchange-digest] could not save the digests:', error)
    }
  }
}
