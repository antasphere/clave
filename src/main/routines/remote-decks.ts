/**
 * The decks of a connected server's runs, kept on this Mac (PRDCT-4149). A
 * Mac attached to a server cannot reach that server's loopback viewer, so a
 * run's filled page is read over the API (`GetRoutineDeck`) and written here,
 * one folder per server and run, where the preview protocol serves it to the
 * hardened page guest. The ids come from a server, so neither may name a
 * path: each becomes one safe path segment, and the page is bounded the way
 * the deck writer bounds a template.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { MAX_TEMPLATE_BYTES } from './deck'

/** One path segment from a server's id: the safe characters kept, every other
 *  one `_`; a value that would still be empty or a dot segment becomes a
 *  hash of itself, so two such values never share a folder. */
export function safeSegment(raw: string): string {
  const kept = raw.replace(/[^A-Za-z0-9._-]/g, '_')
  if (kept === '' || kept === '.' || kept === '..')
    return createHash('sha256').update(raw).digest('hex').slice(0, 16)
  return kept
}

/** Write a run's deck page under `root` and answer the file's absolute path.
 *  The write is atomic (a temporary file renamed over the page), so the page
 *  guest never reads half a page; the same ids overwrite in place. */
export function cacheRemoteDeck(
  root: string,
  serverId: string,
  runId: string,
  html: string
): string {
  if (Buffer.byteLength(html, 'utf8') > MAX_TEMPLATE_BYTES)
    throw new Error(`The report is larger than ${MAX_TEMPLATE_BYTES} bytes`)
  const base = path.resolve(root)
  const dir = path.join(base, safeSegment(serverId), safeSegment(runId))
  // Belt and braces: a segment can hold no separator, but the folder is
  // checked to be under the root all the same.
  const rel = path.relative(base, dir)
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new Error('The deck path left its root')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'index.html')
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, html, 'utf8')
  fs.renameSync(tmp, file)
  pruneServerDecks(path.dirname(dir), KEEP_REMOTE_DECKS)
  return file
}

/** How many runs' pages a server keeps here: a bound on the folder, not a
 *  promise that every selectable run's page is there (a server keeps twenty
 *  runs per routine, across any number of routines); a page evicted is read
 *  over the API again when its run is selected (round 1, Note 4; round 2). */
export const KEEP_REMOTE_DECKS = 40

/** Keep the newest `keep` run folders of one server, by the page's modification
 *  time, and remove the rest; a folder that cannot be removed is left. */
export function pruneServerDecks(serverDir: string, keep: number): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(serverDir, { withFileTypes: true })
  } catch {
    return
  }
  const runs = entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const page = path.join(serverDir, e.name, 'index.html')
      let mtime = 0
      try {
        mtime = fs.statSync(page).mtimeMs
      } catch {
        /* a folder without its page: the oldest */
      }
      return { name: e.name, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)
  for (const run of runs.slice(keep)) {
    try {
      fs.rmSync(path.join(serverDir, run.name), { recursive: true, force: true })
    } catch {
      /* left for the next prune */
    }
  }
}
