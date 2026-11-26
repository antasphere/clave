/**
 * The machine's own « New links go to » (PRDCT-4266): which of its Slideless
 * sites an artefact's first link goes to, one JSON document in the server's
 * data folder (`slideless-settings.json`):
 *
 *   { "v": 1, "newLinksSite": "<origin>" | null }
 *
 * Kept over a storage of one text, as the links are (`links.ts`): an
 * unreadable document reads as empty (no site named), said once in the log,
 * and the next write replaces it; the file is owner-only, written through a
 * rename (`fileLinksStorage`), and an origin longer than `MAX_ORIGIN` is not
 * one it keeps.
 *
 * Every origin the accounts and the links compare or store is in ONE normal
 * form, `normalOrigin`: the command, the person and an older record may each
 * spell a site its own way.
 */
import type { LinksStorage } from './links'

export const SETTINGS_FILE = 'slideless-settings.json'
/** The longest origin the document keeps. */
export const MAX_ORIGIN = 2048

/**
 * A site's origin in the one form it is compared and stored in: the scheme
 * and the host lowercased, the default port dropped, no trailing slash (a
 * path a site is served under is kept), nothing of a user, a query or a
 * fragment. A value that is no http(s) address is only trimmed of its spaces
 * and its trailing slashes.
 */
export function normalOrigin(value: string): string {
  const text = value.trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return text.replace(/\/+$/, '')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return text.replace(/\/+$/, '')
  // URL lowercases the scheme and the host, and drops the scheme's own port.
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

export class SlidelessSettings {
  /** The unreadable text already said in the log: said once, not at every read. */
  private reported: string | null = null

  constructor(
    private readonly storage: LinksStorage,
    private readonly log: (message: string) => void = (message) => console.warn(message)
  ) {}

  /** The site new links go to, in normal form; null when none is named. */
  newLinksSite(): string | null {
    const text = this.storage.read()
    if (text === null) return null
    try {
      const parsed = JSON.parse(text) as { v?: unknown; newLinksSite?: unknown }
      if (parsed.v !== 1) throw new Error('not a version 1 settings document')
      const site = parsed.newLinksSite
      if (site === null || site === undefined) return null
      if (typeof site !== 'string' || site.trim() === '' || site.length > MAX_ORIGIN)
        throw new Error('newLinksSite is not an origin')
      return normalOrigin(site)
    } catch (error) {
      if (this.reported === text) return null
      this.reported = text
      this.log(
        `[artefacts] the Slideless settings could not be read, read as empty: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  /** Names the site new links go to (stored in normal form), or none. */
  setNewLinksSite(origin: string | null): void {
    const document = { v: 1, newLinksSite: origin === null ? null : normalOrigin(origin) }
    this.storage.write(`${JSON.stringify(document, null, 2)}\n`)
  }
}
