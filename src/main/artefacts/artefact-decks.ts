/**
 * The decks of a server's artefacts (PRDCT-4266): for each artefact Clave
 * pushed, its deck on a Slideless site and the links Clave made to it, one
 * JSON document in the server's data folder (`artefact-decks.json`):
 *
 *   { "v": 1,
 *     "decks": { "<absolute target>": { "site", "deckId", "title", "version",
 *       "pushedAt", "links": [{ "tokenId", "name", "url", "createdAt",
 *       "expiresAt", "pinnedVersion", "hasPassword" }, …] } } }
 *
 * Kept over a storage of one text, as the links are (`links.ts`), but with
 * the rule of the command's own profiles file: a record that EXISTS and
 * cannot be read or parsed is an error, never an empty record, and nothing
 * is written over it, since it holds every link's revocation token. Every
 * read and every write is then refused with the sentence naming the file
 * (`recordUnreadable`); only a missing file is an empty record. The same rule
 * holds for one entry: an entry this version cannot read (one a later release
 * wrote, a beta sharing the stable app's data folder, or a hand edit) is never
 * offered as a deck and never dropped. Every write carries it over as the JSON
 * value it was read, outside the bound, and the view, the share and the
 * revocation of its target are refused with the sentence; every other target
 * works. And for one link: a link this version cannot read, in a deck entry it
 * can, is carried over every write of that entry as the JSON value it was
 * read, after the links it can read; it is never offered (not in the view's
 * links, never revoked nor counted by Clave) and never pushed out by the bound
 * of a deck's links. The file is owner-only, written through a rename
 * (`fileDecksStorage`), since a link's URL is a bearer. Bounded: at most
 * `MAX_DECKS` decks, the one pushed longest ago going first (never the one
 * being written), and `MAX_LINKS_PER_DECK` links per deck, its oldest going
 * first. A deck pushed anew keeps its links; a new deck starts with none, the
 * links its entry held that this version cannot read included.
 */
import { readFileSync } from 'node:fs'
import type { ArtefactShareLink } from '@clave/contract/artefacts'
import { fileLinksStorage, type LinksStorage } from './links'
import { ArtefactRefusal } from './refusal'
import { normalOrigin } from './slideless-settings'

export const DECKS_FILE = 'artefact-decks.json'
/** The decks the document keeps. */
export const MAX_DECKS = 500
/** The links a deck keeps. */
export const MAX_LINKS_PER_DECK = 50

/** An artefact's deck as the server records it. */
export interface DeckRecord {
  /** The site's origin, in normal form. */
  readonly site: string
  readonly deckId: string
  readonly title: string
  readonly version: number
  readonly pushedAt: string
  /** Oldest first. */
  readonly links: readonly ArtefactShareLink[]
}

/** What a push records of a deck: everything but its links. */
export type DeckPush = Omit<DeckRecord, 'links'>

/** The record's one text, and the file it is (named when it cannot be read).
 *  `read` answers null only for a record that does not exist yet. */
export interface DecksStorage extends LinksStorage {
  readonly file: string
}

/** The sentence of a record that exists and cannot be read: nothing was changed. */
export const recordUnreadable = (file: string, reason: string): string =>
  `Clave's record of the shared pages (${file}) could not be read: ${reason.replace(/[.\s]+$/, '')}. Nothing was changed.`

/** Why the record could not be read, in the error's words: an OS error by its
 *  code and message (`EACCES: permission denied`), never the path the
 *  sentence names already; any other error by its message. */
export function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const { code, syscall, path } = error as NodeJS.ErrnoException
  if (typeof code !== 'string' || typeof path !== 'string') return error.message
  const at = typeof syscall === 'string' ? error.message.indexOf(`, ${syscall} '${path}'`) : -1
  return at > 0 ? error.message.slice(0, at) : code
}

/** The decks record as a file, owner-only, written through a rename as the
 *  links document is (`fileLinksStorage`); unlike it, only a missing file
 *  reads as none: any other failure to read it is thrown. */
export function fileDecksStorage(file: string): DecksStorage {
  const { write } = fileLinksStorage(file)
  return {
    file,
    read: () => {
      try {
        return readFileSync(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    write
  }
}

const isLink = (value: unknown): value is ArtefactShareLink => {
  if (typeof value !== 'object' || value === null) return false
  const link = value as Record<string, unknown>
  return (
    typeof link.tokenId === 'string' &&
    link.tokenId !== '' &&
    typeof link.name === 'string' &&
    typeof link.url === 'string' &&
    typeof link.createdAt === 'string' &&
    (link.expiresAt === null || typeof link.expiresAt === 'string') &&
    (link.pinnedVersion === null || typeof link.pinnedVersion === 'number') &&
    typeof link.hasPassword === 'boolean'
  )
}

const copyLink = (link: ArtefactShareLink): ArtefactShareLink => ({
  tokenId: link.tokenId,
  name: link.name,
  url: link.url,
  createdAt: link.createdAt,
  expiresAt: link.expiresAt,
  pinnedVersion: link.pinnedVersion,
  hasPassword: link.hasPassword
})

/** A deck entry read from the document: its record (the fields checked, the
 *  links it can read bounded), and the links it cannot read, as the JSON
 *  values they were read; null when the entry is no deck this version reads. */
const entryOf = (value: unknown): { record: DeckRecord; unread: unknown[] } | null => {
  if (typeof value !== 'object' || value === null) return null
  const deck = value as Record<string, unknown>
  if (
    typeof deck.site !== 'string' ||
    typeof deck.deckId !== 'string' ||
    deck.deckId === '' ||
    typeof deck.title !== 'string' ||
    typeof deck.version !== 'number' ||
    typeof deck.pushedAt !== 'string'
  )
    return null
  const links: unknown[] = Array.isArray(deck.links) ? deck.links : []
  return {
    record: {
      site: normalOrigin(deck.site),
      deckId: deck.deckId,
      title: deck.title,
      version: deck.version,
      pushedAt: deck.pushedAt,
      links: links.filter(isLink).map(copyLink).slice(-MAX_LINKS_PER_DECK)
    },
    unread: links.filter((link) => !isLink(link))
  }
}

/** The record as this version reads it: its decks, each entry it cannot read
 *  (kept as the JSON value it was read), and, by target, the links a deck it
 *  reads holds that it cannot (kept the same way). */
interface RecordRead {
  readonly decks: Record<string, DeckRecord>
  readonly kept: Record<string, unknown>
  readonly unread: Record<string, unknown[]>
}

const owns = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key)

export class ArtefactDecks {
  constructor(private readonly storage: DecksStorage) {}

  /** The deck of an artefact, by its absolute target; refused for a target
   *  whose entry this version cannot read. */
  get(target: string): DeckRecord | undefined {
    return this.readFor(target).decks[target]
  }

  /** The decks this version reads: an entry it cannot read is never one of them. */
  all(): Record<string, DeckRecord> {
    return this.read().decks
  }

  /** Records a push: the same deck on the same site keeps its links, another
   *  starts with none (the links of the old one this version cannot read included). */
  pushed(target: string, push: DeckPush): DeckRecord {
    const { decks, kept, unread } = this.readFor(target)
    const before = decks[target]
    const site = normalOrigin(push.site)
    const same = before !== undefined && before.site === site && before.deckId === push.deckId
    const record: DeckRecord = {
      site,
      deckId: push.deckId,
      title: push.title,
      version: push.version,
      pushedAt: push.pushedAt,
      links: same ? before.links : []
    }
    if (!same) delete unread[target]
    decks[target] = record
    this.write(decks, kept, unread, target)
    return record
  }

  /** Adds a link Clave made to the artefact's deck; over the bound, its oldest goes
   *  (the share refuses a link past it first: the bound only protects the file). */
  addLink(target: string, link: ArtefactShareLink): DeckRecord | undefined {
    const { decks, kept, unread } = this.readFor(target)
    const before = decks[target]
    if (!before) return undefined
    const links = [...before.links.filter((l) => l.tokenId !== link.tokenId), copyLink(link)]
    const record = { ...before, links: links.slice(-MAX_LINKS_PER_DECK) }
    decks[target] = record
    this.write(decks, kept, unread, target)
    return record
  }

  /** Lets go of one of the deck's links, once it is revoked. */
  removeLink(target: string, tokenId: string): DeckRecord | undefined {
    const { decks, kept, unread } = this.readFor(target)
    const before = decks[target]
    if (!before) return undefined
    const record = { ...before, links: before.links.filter((l) => l.tokenId !== tokenId) }
    decks[target] = record
    this.write(decks, kept, unread, target)
    return record
  }

  /** The record, refused for a target whose entry this version cannot read:
   *  that entry is never shown, pushed over, nor written in place of. */
  private readFor(target: string): RecordRead {
    const read = this.read()
    if (owns(read.kept, target))
      throw this.unreadable(`its entry for ${target} is not one this version of Clave can read`)
    return read
  }

  /** The record's decks, and the entries this version cannot read; a missing
   *  file is none. A file that exists and cannot be read or parsed is refused,
   *  so that every write, which reads first, leaves it as it is. */
  private read(): RecordRead {
    let parsed: unknown
    try {
      const text = this.storage.read()
      if (text === null) return { decks: {}, kept: {}, unread: {} }
      parsed = JSON.parse(text)
    } catch (error) {
      throw this.unreadable(reasonOf(error))
    }
    const document = parsed as { v?: unknown; decks?: unknown } | null
    if (
      typeof document !== 'object' ||
      document === null ||
      document.v !== 1 ||
      typeof document.decks !== 'object' ||
      document.decks === null ||
      Array.isArray(document.decks)
    )
      throw this.unreadable('it is not a version 1 record')
    const decks: Record<string, DeckRecord> = {}
    const kept: Record<string, unknown> = {}
    const unread: Record<string, unknown[]> = {}
    for (const [target, value] of Object.entries(document.decks as Record<string, unknown>)) {
      const entry = entryOf(value)
      if (!entry) kept[target] = value
      else {
        decks[target] = entry.record
        if (entry.unread.length > 0) unread[target] = entry.unread
      }
    }
    return { decks, kept, unread }
  }

  private unreadable(reason: string): ArtefactRefusal {
    return new ArtefactRefusal(recordUnreadable(this.storage.file, reason))
  }

  /** Writes the document: the decks, the ones pushed longest ago going over the
   *  bound (`keep` never), each with the links it holds that this version cannot
   *  read after the ones it can (outside the bound of a deck's links), then
   *  every entry this version cannot read, as the value it was read, never
   *  counted in the bound and never evicted by it. */
  private write(
    decks: Record<string, DeckRecord>,
    kept: Record<string, unknown>,
    unread: Record<string, unknown[]>,
    keep: string
  ): void {
    const excess = Object.keys(decks).length - MAX_DECKS
    if (excess > 0) {
      const oldest = Object.keys(decks)
        .filter((target) => target !== keep)
        .sort((a, b) => (decks[a]!.pushedAt < decks[b]!.pushedAt ? -1 : 1))
        .slice(0, excess)
      for (const target of oldest) delete decks[target]
    }
    const written: Record<string, unknown> = {}
    for (const [target, record] of Object.entries(decks)) {
      const theirs = owns(unread, target) ? unread[target]! : []
      written[target] =
        theirs.length > 0 ? { ...record, links: [...record.links, ...theirs] } : record
    }
    this.storage.write(`${JSON.stringify({ v: 1, decks: { ...written, ...kept } }, null, 2)}\n`)
  }
}
