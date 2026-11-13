/**
 * Which tab opened which (wave 4, PRDCT-3377): the parent link an agent
 * needs to answer "parent" in `clave_send_to_session` and
 * `clave_read_session`, and the relationship the name tie-break reads. Kept in
 * the memory of the process that serves the tools, as the window kept it
 * in its store: set when an agent's `clave_open_session` starts a tab,
 * forgotten when the tab's process ends.
 *
 * Since PRDCT-4193 the map is also written to a file when one is named
 * (`initLineage`, the shell's `lineage.json` under its user data): a tab this
 * Mac opened on a Clave server is known here by its full key, and that
 * server's record cannot carry the link (the opener is a tab of this Mac,
 * which the server cannot name), so the Mac keeps it, across its own
 * restarts and the window's reloads. A same-host link lives on the record
 * too (`openedBy`), and the tools read the record as the fallback. Entries
 * are dropped when the tab's process ends (`forgetLineage`) and, at load,
 * when older than `KEEP_MS`: a server tab closed while this Mac was away
 * leaves no event here, so age is what bounds the file. No Electron import:
 * the file is a path the caller names.
 */
import * as fs from 'node:fs'

const parents = new Map<string, string>()
const since = new Map<string, number>()
let file: string | null = null
/** How long an entry outlives the last word about its tab: thirty days. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000

interface Saved {
  readonly v: 1
  readonly parents: Record<string, { parent: string; at: number }>
}

/** Read the file into memory and write through from here on. A file that
 *  cannot be read starts empty; one that cannot be written leaves the map
 *  in memory alone, as before. */
export function initLineage(path: string, now: () => number = Date.now): void {
  file = path
  parents.clear()
  since.clear()
  let saved: Saved | null = null
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8')) as Partial<Saved>
    if (parsed && parsed.v === 1 && parsed.parents && typeof parsed.parents === 'object')
      saved = parsed as Saved
  } catch {
    saved = null
  }
  if (!saved) return
  const floor = now() - KEEP_MS
  for (const [child, entry] of Object.entries(saved.parents)) {
    if (!entry || typeof entry.parent !== 'string' || typeof entry.at !== 'number') continue
    if (entry.at < floor) continue
    parents.set(child, entry.parent)
    since.set(child, entry.at)
  }
}

function persist(): void {
  if (!file) return
  const out: Saved = { v: 1, parents: {} }
  for (const [child, parent] of parents)
    out.parents[child] = { parent, at: since.get(child) ?? Date.now() }
  try {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (error) {
    console.error('[lineage] could not be written:', error)
  }
}

export function setParent(childId: string, parentId: string): void {
  if (childId === parentId) return
  parents.set(childId, parentId)
  since.set(childId, Date.now())
  persist()
}

/** The tab that opened this one, or null. */
export function parentOf(childId: string): string | null {
  return parents.get(childId) ?? null
}

/** The tabs this one opened. */
export function childrenOf(parentId: string): string[] {
  return [...parents].filter(([, parent]) => parent === parentId).map(([child]) => child)
}

/** Every link, child → opener, for a window to read (PRDCT-4193). */
export function lineageParents(): Record<string, string> {
  return Object.fromEntries(parents)
}

export function forgetLineage(id: string): void {
  if (!parents.has(id)) return
  parents.delete(id)
  since.delete(id)
  persist()
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The parent a session's RECORD carries (#259), which is what survives the
 * restart this map does not: the spawn's, else the previous record's. It
 * crosses the IPC boundary and lands in a file re-read at boot, so only a
 * session id is kept, anything else dropped, never coerced; a session is
 * never its own parent.
 */
export function lineageOf(id: string, requested: unknown, previous: unknown): string | undefined {
  const valid = (v: unknown): string | undefined =>
    typeof v === 'string' && SESSION_ID.test(v) ? v : undefined
  const parent = valid(requested) ?? valid(previous)
  return parent === id ? undefined : parent
}

/** Tests only. */
export function resetLineageForTests(): void {
  parents.clear()
  since.clear()
  file = null
}
