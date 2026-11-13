/**
 * The links between a server's sessions and their artefacts (PRDCT-4472),
 * one JSON document in the server's data folder (`artefacts.json`):
 *
 *   { "v": 1, "artefacts": { "<sessionId>": { "target", "page", "title", "openedAt" } } }
 *
 * Kept over a storage of one text so the rules run in tests without a disk.
 * An unreadable document reads as empty, said once in the log, and the next
 * write replaces it: a broken file must never stop an agent from opening a
 * page. The document keeps at most `MAX_LINKS` links, so a server that runs
 * for months never grows it without end. Over that bound the links of the
 * sessions the caller does not spare go first, oldest by `openedAt` first,
 * and a spared session's link goes only when every link left is spared: the
 * service spares the sessions it knows, so tabs closed for good make room
 * before a tab that still runs loses its page. The link being set is never
 * the one evicted. That is the document's only bound: the service never
 * drops a link because it does not know its session yet (a terminal tab is
 * known by its id only once a window has taken it back after a restart).
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const MAX_LINKS = 500

export interface ArtefactLink {
  readonly target: string
  readonly page: string
  readonly title: string
  readonly openedAt: string
}

export interface LinksStorage {
  read(): string | null
  write(text: string): void
}

interface LinksDocument {
  v: 1
  artefacts: Record<string, ArtefactLink>
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

export class ArtefactLinks {
  /** The unreadable text already said in the log: said once, not at every read. */
  private reported: string | null = null

  constructor(
    private readonly storage: LinksStorage,
    private readonly log: (message: string) => void = (message) => console.warn(message)
  ) {}

  get(sessionId: string): ArtefactLink | undefined {
    return this.read()[sessionId]
  }

  /**
   * Sets a session's link. `spare` names the sessions whose links are
   * evicted last when the document is over its bound; without it every link
   * is evicted by age alone.
   */
  set(sessionId: string, link: ArtefactLink, spare?: (sessionId: string) => boolean): void {
    const links = { ...this.read(), [sessionId]: link }
    const excess = Object.keys(links).length - MAX_LINKS
    if (excess > 0) {
      const byAge = (a: string, b: string): number =>
        links[a]!.openedAt < links[b]!.openedAt ? -1 : 1
      // The link being set is never a candidate, whatever its openedAt says.
      const spared: string[] = []
      const unspared: string[] = []
      for (const id of Object.keys(links))
        if (id !== sessionId) (spare?.(id) ? spared : unspared).push(id)
      const evicted = [...unspared.sort(byAge), ...spared.sort(byAge)].slice(0, excess)
      for (const id of evicted) delete links[id]
    }
    this.write(links)
  }

  remove(sessionId: string): void {
    const links = this.read()
    if (!(sessionId in links)) return
    delete links[sessionId]
    this.write(links)
  }

  all(): Record<string, ArtefactLink> {
    return this.read()
  }

  private read(): Record<string, ArtefactLink> {
    const text = this.storage.read()
    if (text === null) return {}
    try {
      const parsed = JSON.parse(text) as Partial<LinksDocument>
      if (parsed.v !== 1 || typeof parsed.artefacts !== 'object' || parsed.artefacts === null)
        throw new Error('not a version 1 links document')
      const links: Record<string, ArtefactLink> = {}
      for (const [id, link] of Object.entries(parsed.artefacts))
        if (isLink(link))
          links[id] = {
            target: link.target,
            page: link.page,
            title: link.title,
            openedAt: link.openedAt
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

  private write(links: Record<string, ArtefactLink>): void {
    const document: LinksDocument = { v: 1, artefacts: links }
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
