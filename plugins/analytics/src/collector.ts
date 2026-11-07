import { EventEmitter } from 'node:events'
import * as nodeFs from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { foldEvents, parseLine } from './claude'
import { emptyTally, type Ledger, type SessionRow, type SubagentRow, type Tally } from './ledger'
import type { PluginSession } from './host'
import { newCursor, readMore, type FileCursor } from './reader'

/**
 * Keeps the ledger in step with the sessions Clave shows and the transcripts on disk.
 * `setSessions` upserts one row per session (and ends the rows of the sessions that went
 * away); `tick` reads what every tracked transcript gained since the last read. It wakes
 * on a watch of each project folder and on a timer (2 s while a session works, 30 s
 * otherwise), and emits `changed` with the ids of the sessions whose rows moved.
 */

/** The providers whose sessions are Claude Code tabs, read from Claude Code's transcripts. */
const CLAUDE_PROVIDERS = new Set(['claude', 'claude-agents'])

/** Claude Code's project folder name for a cwd: every non-alphanumeric character → `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

export interface CollectorOptions {
  transcriptRoot?: string
  ledger: Ledger
  gapMinutes: number
  fs?: typeof nodeFs
  now?: () => Date
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
}

interface SubagentMeta {
  type: string | null
  description: string | null
  model: string | null
  finished: boolean | null
}

const FAST_MS = 2_000
const SLOW_MS = 30_000
const WATCH_DEBOUNCE_MS = 300

export class Collector extends EventEmitter {
  readonly ledger: Ledger
  readonly transcriptRoot: string
  private readonly fs: typeof nodeFs
  private readonly now: () => Date
  private present = new Set<string>()
  private watchers = new Map<string, nodeFs.FSWatcher>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private watchTimer: ReturnType<typeof setTimeout> | null = null
  private started = false

  constructor(options: CollectorOptions) {
    super()
    this.ledger = options.ledger
    this.ledger.gapMinutes = options.gapMinutes
    this.transcriptRoot = options.transcriptRoot ?? join(homedir(), '.claude', 'projects')
    this.fs = options.fs ?? nodeFs
    this.now = options.now ?? ((): Date => new Date())
  }

  rootPath(cwd: string, providerSessionId: string): string {
    return join(this.transcriptRoot, projectSlug(cwd), `${providerSessionId}.jsonl`)
  }

  /** Upserts the rows of the sessions Clave shows; a session no longer listed is ended. */
  setSessions(sessions: PluginSession[]): Set<string> {
    const at = this.now().toISOString()
    const touched = new Set<string>()
    const ids = new Set<string>()
    for (const s of sessions) {
      ids.add(s.id)
      if (this.upsert(s, at)) touched.add(s.id)
    }
    for (const row of Object.values(this.ledger.sessions)) {
      if (ids.has(row.id) || row.state === 'ended') continue
      closeSpan(row, at)
      row.state = 'ended'
      touched.add(row.id)
    }
    this.present = ids
    this.ensureWatchers()
    for (const id of this.readAll()) touched.add(id)
    this.finish(touched)
    return touched
  }

  /** Reads every tracked transcript; emits `changed` when anything moved. */
  tick(): Set<string> {
    const touched = this.readAll()
    this.ensureWatchers()
    this.finish(touched)
    return touched
  }

  start(): void {
    this.started = true
    this.ensureWatchers()
    this.arm()
  }

  /** Changes the gap the activity blocks are cut with; every open page redraws. */
  setGap(minutes: number): void {
    if (this.ledger.gapMinutes === minutes) return
    this.ledger.gapMinutes = minutes
    this.touch()
  }

  /** Says every row changed without reading anything: a price edit, a publish, a new gap. */
  touch(): void {
    this.ledger.updatedAt = this.now().toISOString()
    this.emit('changed', new Set(Object.keys(this.ledger.sessions)))
  }

  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.timer = null
    this.watchTimer = null
    for (const w of this.watchers.values()) {
      try {
        w.close()
      } catch {
        /* already closed */
      }
    }
    this.watchers.clear()
  }

  private finish(touched: Set<string>): void {
    if (touched.size > 0) {
      this.ledger.updatedAt = this.now().toISOString()
      this.emit('changed', touched)
    }
    this.arm()
  }

  private upsert(s: PluginSession, at: string): boolean {
    let row = this.ledger.sessions[s.id]
    let changed = false
    if (!row) {
      row = {
        id: s.id,
        provider: s.provider,
        providerSessionId: s.providerSessionId,
        cwd: s.cwd,
        name: s.name,
        model: s.model,
        state: s.state,
        group: s.group ? { id: s.group.id, name: s.group.name } : null,
        workspaceId: s.workspaceId,
        createdAt: s.createdAt,
        seenAt: at,
        root: null,
        subagents: [],
        stateSpans: [{ state: s.state, from: at, to: null }]
      }
      this.ledger.sessions[s.id] = row
      changed = true
    } else {
      if (row.state !== s.state) {
        closeSpan(row, at)
        row.stateSpans.push({ state: s.state, from: at, to: null })
        row.state = s.state
        changed = true
      }
      const group = s.group ? { id: s.group.id, name: s.group.name } : null
      if (
        row.name !== s.name ||
        row.model !== s.model ||
        row.provider !== s.provider ||
        row.cwd !== s.cwd ||
        row.workspaceId !== s.workspaceId ||
        row.providerSessionId !== s.providerSessionId ||
        JSON.stringify(row.group) !== JSON.stringify(group)
      ) {
        changed = true
      }
      row.name = s.name
      row.model = s.model
      row.provider = s.provider
      row.cwd = s.cwd
      row.workspaceId = s.workspaceId
      row.providerSessionId = s.providerSessionId
      row.group = group
      row.seenAt = at
    }
    if (CLAUDE_PROVIDERS.has(s.provider) && s.providerSessionId) {
      const path = this.rootPath(s.cwd, s.providerSessionId)
      // A new conversation in the same tab (a new provider session id) starts a new file;
      // the tab's tally carries on.
      if (!row.root) row.root = { tally: emptyTally(), file: newCursor(path) }
      else if (row.root.file.path !== path) row.root.file = newCursor(path)
    }
    return changed
  }

  private tracked(): SessionRow[] {
    return [...this.present]
      .map((id) => this.ledger.sessions[id])
      .filter((row): row is SessionRow => !!row && row.root !== null)
  }

  private readAll(): Set<string> {
    const touched = new Set<string>()
    for (const row of this.tracked()) {
      try {
        if (this.readSession(row)) touched.add(row.id)
      } catch {
        /* an unreadable transcript is read again on the next tick */
      }
    }
    return touched
  }

  private readFile(
    file: FileCursor,
    tally: () => Tally,
    reset: () => void
  ): {
    file: FileCursor
    changed: boolean
  } {
    const result = readMore(file, this.fs)
    if (result.reset) reset()
    if (result.lines.length > 0)
      foldEvents(result.lines.map(parseLine), tally(), result.cursor.seen)
    return { file: result.cursor, changed: result.reset || result.bytesRead > 0 }
  }

  private readSession(row: SessionRow): boolean {
    const root = row.root!
    let changed = false
    const read = this.readFile(
      root.file,
      () => root.tally,
      () => (root.tally = emptyTally())
    )
    root.file = read.file
    changed ||= read.changed

    const dir = join(dirname(root.file.path), basename(root.file.path, '.jsonl'), 'subagents')
    let names: string[] = []
    try {
      names = this.fs.readdirSync(dir)
    } catch {
      /* no subagents folder: no fan-out yet */
    }
    for (const name of names.sort()) {
      const m = /^agent-(.+)\.jsonl$/.exec(name)
      if (!m || row.subagents.some((s) => s.id === m[1])) continue
      row.subagents.push({
        id: m[1]!,
        type: null,
        description: null,
        model: null,
        finished: null,
        tally: emptyTally(),
        file: newCursor(join(dir, name))
      })
      changed = true
    }
    for (const sub of row.subagents) {
      const r = this.readFile(
        sub.file,
        () => sub.tally,
        () => (sub.tally = emptyTally())
      )
      sub.file = r.file
      changed ||= r.changed
      if (sub.finished !== true) changed = this.refreshMeta(sub) || changed
    }
    return changed
  }

  private refreshMeta(sub: SubagentRow): boolean {
    const path = sub.file.path.replace(/\.jsonl$/, '.meta.json')
    let meta: SubagentMeta
    try {
      const raw = JSON.parse(this.fs.readFileSync(path, 'utf8')) as Record<string, unknown>
      const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
      meta = {
        type: s(raw['agentType']),
        description: s(raw['description']),
        model: s(raw['model']),
        finished: typeof raw['finished'] === 'boolean' ? raw['finished'] : null
      }
    } catch {
      return false
    }
    const changed =
      sub.type !== meta.type ||
      sub.description !== meta.description ||
      sub.model !== meta.model ||
      sub.finished !== meta.finished
    Object.assign(sub, meta)
    return changed
  }

  private projectDirs(): Set<string> {
    const dirs = new Set<string>()
    for (const row of this.tracked()) dirs.add(dirname(row.root!.file.path))
    return dirs
  }

  private ensureWatchers(): void {
    if (!this.started) return
    const wanted = this.projectDirs()
    for (const [dir, watcher] of this.watchers) {
      if (wanted.has(dir)) continue
      try {
        watcher.close()
      } catch {
        /* already closed */
      }
      this.watchers.delete(dir)
    }
    for (const dir of wanted) {
      if (this.watchers.has(dir)) continue
      try {
        const watcher = this.fs.watch(dir, { persistent: false }, () => this.onWatch())
        watcher.on('error', () => {
          // The folder went away or cannot be watched: the timer carries on alone.
          try {
            watcher.close()
          } catch {
            /* already closed */
          }
          this.watchers.delete(dir)
        })
        this.watchers.set(dir, watcher)
      } catch {
        /* the folder does not exist yet: the timer is the fallback, retried each tick */
      }
    }
  }

  private onWatch(): void {
    if (!this.started) return
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null
      if (this.started) this.tick()
    }, WATCH_DEBOUNCE_MS)
    this.watchTimer.unref?.()
  }

  private arm(): void {
    if (!this.started) return
    if (this.timer) clearTimeout(this.timer)
    const fast = this.tracked().some((row) => row.state === 'working')
    this.timer = setTimeout(
      () => {
        this.timer = null
        if (this.started) this.tick()
      },
      fast ? FAST_MS : SLOW_MS
    )
    this.timer.unref?.()
  }
}

function closeSpan(row: SessionRow, at: string): void {
  const last = row.stateSpans[row.stateSpans.length - 1]
  if (last && last.to === null) last.to = at
}
