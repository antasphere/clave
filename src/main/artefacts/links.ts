/**
 * The links between a server's sessions and their artefacts (PRDCT-4472),
 * one JSON document in the server's data folder (`artefacts.json`). A
 * session keeps several artefacts (PRDCT-5022), oldest first, the one it
 * shows in front (last):
 *
 *   { "v": 1,
 *     "artefacts": { "<sessionId>": { "target", "page", "title", "openedAt" } },
 *     "lists": { "<sessionId>": [{ "target", "page", "title", "openedAt" }, …] } }
 *
 * `artefacts` keeps each session's front, the shape a build before several
 * artefacts reads: going back to one (a beta's way back to stable, a server
 * downgraded) finds every session's front rather than an unreadable file it
 * would replace. Such a build rewrites the document without `lists`, and a
 * session with no list reads as a list of its front. A `v: 2` document (an
 * earlier shape of this change, never released) reads too.
 *
 * Kept over a storage of one text so the rules run in tests without a disk.
 * An unreadable document reads as empty, said once in the log, and the next
 * write replaces it: a broken file must never stop an agent from opening a
 * page. A session keeps at most `MAX_PER_SESSION` artefacts (its oldest goes
 * first), and the document at most `MAX_LINKS` sessions, so a server that
 * runs for months never grows it without end. Over that bound the sessions
 * the caller does not spare go first, oldest by their front's `openedAt`
 * first, and a spared session goes only when every one left is spared: the
 * service spares the sessions it knows, so tabs closed for good make room
 * before a tab that still runs loses its pages. The session being set is
 * never the one evicted. That is the document's only bound: the service
 * never drops a link because it does not know its session yet (a terminal
 * tab is known by its id only once a window has taken it back after a
 * restart).
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The sessions the document keeps. */
export const MAX_LINKS = 500
/** The artefacts a session keeps. */
export const MAX_PER_SESSION = 12

export interface ArtefactLink {
  readonly target: string
  readonly page: string
  readonly title: string
  readonly openedAt: string
}

/** A link a change let go of, and the session it was one of. */
export interface DroppedLink {
  readonly sessionId: string
  readonly link: ArtefactLink
}

export interface LinksStorage {
  read(): string | null
  write(text: string): void
}

interface LinksDocument {
  v: 1
  /** Each session's front: what a build that keeps one artefact per session reads. */
  artefacts: Record<string, ArtefactLink>
  /** Each session's artefacts, oldest first, the front last. */
  lists: Record<string, ArtefactLink[]>
}

const isLink = (value: unknown): value is ArtefactLink => {
  if (typeof value !== 'object' || value === null) return false
  const link = value as Record<string, unknown>
  return (
    typeof link.target === 'string' &&
    typeof link.page === 'string' &&
    typeof link.title === 'string' &&
    typeof link.openedAt === 'string'
  )
}

const copy = (link: ArtefactLink): ArtefactLink => ({
  target: link.target,
  page: link.page,
  title: link.title,
  openedAt: link.openedAt
})

/** A session's front: the artefact it shows, its latest open. */
const frontOf = (links: readonly ArtefactLink[]): ArtefactLink | undefined => links.at(-1)

export class ArtefactLinks {
  /** The unreadable text already said in the log: said once, not at every read. */
  private reported: string | null = null

  constructor(
    private readonly storage: LinksStorage,
    private readonly log: (message: string) => void = (message) => console.warn(message)
  ) {}

  /** The session's front artefact: the one it opened last. */
  get(sessionId: string): ArtefactLink | undefined {
    return frontOf(this.read()[sessionId] ?? [])
  }

  /** The session's artefacts, oldest first, the front last. */
  list(sessionId: string): ArtefactLink[] {
    return this.read()[sessionId] ?? []
  }

  /** The session's artefact of this folder or file. */
  find(sessionId: string, target: string): ArtefactLink | undefined {
    return this.list(sessionId).find((link) => link.target === target)
  }

  /**
   * Opens an artefact for a session: added in front, or moved there with its
   * new open when the session has it already. Answers the links let go of:
   * the session's oldest over `MAX_PER_SESSION`, and whole sessions over
   * `MAX_LINKS`. `spare` names the sessions evicted last; without it every
   * session is evicted by age alone.
   */
  set(
    sessionId: string,
    link: ArtefactLink,
    spare?: (sessionId: string) => boolean
  ): DroppedLink[] {
    const links = this.read()
    const dropped: DroppedLink[] = []
    const kept = (links[sessionId] ?? []).filter((l) => l.target !== link.target)
    kept.push(copy(link))
    while (kept.length > MAX_PER_SESSION) dropped.push({ sessionId, link: kept.shift()! })
    links[sessionId] = kept
    const excess = Object.keys(links).length - MAX_LINKS
    if (excess > 0) {
      const age = (id: string): string => frontOf(links[id]!)?.openedAt ?? ''
      const byAge = (a: string, b: string): number => (age(a) < age(b) ? -1 : 1)
      // The session being set is never a candidate, whatever its openedAt says.
      const spared: string[] = []
      const unspared: string[] = []
      for (const id of Object.keys(links))
        if (id !== sessionId) (spare?.(id) ? spared : unspared).push(id)
      const evicted = [...unspared.sort(byAge), ...spared.sort(byAge)].slice(0, excess)
      for (const id of evicted) {
        for (const gone of links[id]!) dropped.push({ sessionId: id, link: gone })
        delete links[id]
      }
    }
    this.write(links)
    return dropped
  }

  /** Lets go of one of the session's artefacts, or of them all: answers what went. */
  remove(sessionId: string, target?: string): ArtefactLink[] {
    const links = this.read()
    const own = links[sessionId]
    if (!own) return []
    const removed = target === undefined ? own : own.filter((l) => l.target === target)
    if (removed.length === 0) return []
    const left = own.filter((l) => !removed.includes(l))
    if (left.length === 0) delete links[sessionId]
    else links[sessionId] = left
    this.write(links)
    return removed
  }

  all(): Record<string, ArtefactLink[]> {
    return this.read()
  }

  private read(): Record<string, ArtefactLink[]> {
    const text = this.storage.read()
    if (text === null) return {}
    try {
      const parsed = JSON.parse(text) as { v?: unknown; artefacts?: unknown; lists?: unknown }
      if (
        (parsed.v !== 1 && parsed.v !== 2) ||
        typeof parsed.artefacts !== 'object' ||
        parsed.artefacts === null
      )
        throw new Error('not a version 1 links document')
      const fronts = parsed.artefacts as Record<string, unknown>
      const lists =
        parsed.v === 2
          ? fronts
          : typeof parsed.lists === 'object' && parsed.lists !== null
            ? (parsed.lists as Record<string, unknown>)
            : {}
      const links: Record<string, ArtefactLink[]> = {}
      const ids = new Set([...Object.keys(fronts), ...(parsed.v === 2 ? [] : Object.keys(lists))])
      for (const id of ids) {
        const listed = lists[id]
        // A session with no list (a build that keeps one rewrote the document,
        // or wrote it first): its front, a list of one.
        const own = (Array.isArray(listed) ? listed : parsed.v === 1 ? [fronts[id]] : [])
          .filter(isLink)
          .map(copy)
          .slice(-MAX_PER_SESSION)
        if (own.length > 0) links[id] = own
      }
      return links
    } catch (error) {
      if (this.reported === text) return {}
      this.reported = text
      this.log(
        `[artefacts] the links document could not be read, read as empty: ${error instanceof Error ? error.message : String(error)}`
      )
      return {}
    }
  }

  private write(links: Record<string, ArtefactLink[]>): void {
    const fronts: Record<string, ArtefactLink> = {}
    for (const [id, own] of Object.entries(links)) {
      const front = frontOf(own)
      if (front) fronts[id] = front
    }
    const document: LinksDocument = { v: 1, artefacts: fronts, lists: links }
    this.storage.write(`${JSON.stringify(document, null, 2)}\n`)
  }
}

/** The links document as a file, owner-only, written through a rename. */
export function fileLinksStorage(file: string): LinksStorage {
  return {
    read: () => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return null
      }
    },
    write: (text) => {
      mkdirSync(dirname(file), { recursive: true })
      const staging = `${file}.${randomBytes(6).toString('hex')}.tmp`
      writeFileSync(staging, text, { mode: 0o600 })
      renameSync(staging, file)
      chmodSync(file, 0o600)
    }
  }
}
