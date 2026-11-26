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
 * (`recordUnreadable`); only a missing file is an empty record. The file is
 * owner-only, written through a rename (`fileDecksStorage`), since a link's
 * URL is a bearer. Bounded: at most `MAX_DECKS` decks, the one pushed longest
 * ago going first (never the one being written), and `MAX_LINKS_PER_DECK`
 * links per deck, its oldest going first. A deck pushed anew keeps its
 * links; a new deck starts with none.
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

/** A record read from the document, its fields checked and its links bounded; null when it is none. */
const recordOf = (value: unknown): DeckRecord | null => {
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
  return {
    site: normalOrigin(deck.site),
    deckId: deck.deckId,
    title: deck.title,
    version: deck.version,
    pushedAt: deck.pushedAt,
    links: (Array.isArray(deck.links) ? deck.links : [])
      .filter(isLink)
      .map(copyLink)
      .slice(-MAX_LINKS_PER_DECK)
  }
}

export class ArtefactDecks {
  constructor(private readonly storage: DecksStorage) {}

  /** The deck of an artefact, by its absolute target. */
  get(target: string): DeckRecord | undefined {
    return this.read()[target]
  }

  all(): Record<string, DeckRecord> {
    return this.read()
  }

  /** Records a push: the same deck on the same site keeps its links, another starts with none. */
  pushed(target: string, push: DeckPush): DeckRecord {
    const decks = this.read()
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
    decks[target] = record
    this.write(decks, target)
    return record
  }

  /** Adds a link Clave made to the artefact's deck; over the bound, its oldest goes. */
  addLink(target: string, link: ArtefactShareLink): DeckRecord | undefined {
    const decks = this.read()
    const before = decks[target]
    if (!before) return undefined
    const links = [...before.links.filter((l) => l.tokenId !== link.tokenId), copyLink(link)]
    const record = { ...before, links: links.slice(-MAX_LINKS_PER_DECK) }
    decks[target] = record
    this.write(decks, target)
    return record
  }

  /** Lets go of one of the deck's links, once it is revoked. */
  removeLink(target: string, tokenId: string): DeckRecord | undefined {
    const decks = this.read()
    const before = decks[target]
    if (!before) return undefined
    const record = { ...before, links: before.links.filter((l) => l.tokenId !== tokenId) }
    decks[target] = record
    this.write(decks, target)
    return record
  }

  /** The record's decks; a missing file is none. A file that exists and cannot
   *  be read or parsed is refused, so that every write, which reads first,
   *  leaves it as it is. */
  private read(): Record<string, DeckRecord> {
    let parsed: unknown
    try {
      const text = this.storage.read()
      if (text === null) return {}
      parsed = JSON.parse(text)
    } catch (error) {
      throw this.unreadable(error instanceof Error ? error.message : String(error))
    }
    const document = parsed as { v?: unknown; decks?: unknown } | null
    if (
      typeof document !== 'object' ||
      document === null ||
      document.v !== 1 ||
      typeof document.decks !== 'object' ||
      document.decks === null
    )
      throw this.unreadable('it is not a version 1 record')
    const decks: Record<string, DeckRecord> = {}
    for (const [target, value] of Object.entries(document.decks as Record<string, unknown>)) {
      const record = recordOf(value)
      if (record) decks[target] = record
    }
    return decks
  }

  private unreadable(reason: string): ArtefactRefusal {
    return new ArtefactRefusal(recordUnreadable(this.storage.file, reason))
  }

  /** Writes the document; over the bound, the decks pushed longest ago go, `keep` never. */
  private write(decks: Record<string, DeckRecord>, keep: string): void {
    const excess = Object.keys(decks).length - MAX_DECKS
    if (excess > 0) {
      const oldest = Object.keys(decks)
        .filter((target) => target !== keep)
        .sort((a, b) => (decks[a]!.pushedAt < decks[b]!.pushedAt ? -1 : 1))
        .slice(0, excess)
      for (const target of oldest) delete decks[target]
    }
    this.storage.write(`${JSON.stringify({ v: 1, decks }, null, 2)}\n`)
  }
}
