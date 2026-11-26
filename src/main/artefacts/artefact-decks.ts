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
 * Kept over a storage of one text, as the links are (`links.ts`): an
 * unreadable document reads as empty, said once in the log, and the next
 * write replaces it; the file is owner-only, written through a rename
 * (`fileLinksStorage`), since a link's URL is a bearer. Bounded: at most
 * `MAX_DECKS` decks, the one pushed longest ago going first (never the one
 * being written), and `MAX_LINKS_PER_DECK` links per deck, its oldest going
 * first. A deck pushed anew keeps its links; a new deck starts with none.
 */
import type { ArtefactShareLink } from '@clave/contract/artefacts'
import type { LinksStorage } from './links'
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
  /** The unreadable text already said in the log: said once, not at every read. */
  private reported: string | null = null

  constructor(
    private readonly storage: LinksStorage,
    private readonly log: (message: string) => void = (message) => console.warn(message)
  ) {}

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

  private read(): Record<string, DeckRecord> {
    const text = this.storage.read()
    if (text === null) return {}
    try {
      const parsed = JSON.parse(text) as { v?: unknown; decks?: unknown }
      if (parsed.v !== 1 || typeof parsed.decks !== 'object' || parsed.decks === null)
        throw new Error('not a version 1 decks document')
      const decks: Record<string, DeckRecord> = {}
      for (const [target, value] of Object.entries(parsed.decks as Record<string, unknown>)) {
        const record = recordOf(value)
        if (record) decks[target] = record
      }
      return decks
    } catch (error) {
      if (this.reported === text) return {}
      this.reported = text
      this.log(
        `[artefacts] the decks document could not be read, read as empty: ${error instanceof Error ? error.message : String(error)}`
      )
      return {}
    }
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
