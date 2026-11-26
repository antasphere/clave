import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArtefactShareLink } from '@clave/contract/artefacts'
import { ArtefactDecks, MAX_DECKS, MAX_LINKS_PER_DECK, type DeckPush } from './artefact-decks'
import { fileLinksStorage, type LinksStorage } from './links'

/** The record of the artefacts' decks and the links Clave made (PRDCT-4266). */
const memory = (initial: string | null = null): LinksStorage & { text: string | null } => {
  const store = {
    text: initial,
    read: () => store.text,
    write: (text: string) => {
      store.text = text
    }
  }
  return store
}
const SITE = 'https://decks.example.test'
const push = (n: number, over: Partial<DeckPush> = {}): DeckPush => ({
  site: SITE,
  deckId: `d${n}`,
  title: `deck ${n}`,
  version: 1,
  pushedAt: new Date(Date.UTC(2026, 10, 1) + n * 1000).toISOString(),
  ...over
})
const link = (n: number): ArtefactShareLink => ({
  tokenId: `t${n}`,
  name: 'Clave',
  url: `${SITE}/s/secret-${n}`,
  createdAt: new Date(Date.UTC(2026, 10, 2) + n * 1000).toISOString(),
  expiresAt: null,
  pinnedVersion: null,
  hasPassword: false
})

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('the decks record', () => {
  it('records a push, keeps the links of the same deck and starts a new deck with none', () => {
    const storage = memory()
    const decks = new ArtefactDecks(storage)
    expect(decks.get('/work/deck')).toBeUndefined()
    decks.pushed('/work/deck', push(1, { site: 'HTTPS://Decks.Example.test/' }))
    decks.addLink('/work/deck', link(1))
    const again = decks.pushed('/work/deck', push(1, { version: 2 }))
    expect(again).toEqual({ ...push(1, { version: 2 }), links: [link(1)] })
    // Another deck, or the same id on another site, is a new deck: no links.
    expect(decks.pushed('/work/deck', push(2)).links).toEqual([])
    decks.addLink('/work/deck', link(2))
    expect(
      decks.pushed('/work/deck', push(2, { site: 'https://cloud.example.test' })).links
    ).toEqual([])
    expect(JSON.parse(storage.text!)).toEqual({
      v: 1,
      decks: { '/work/deck': { ...push(2, { site: 'https://cloud.example.test' }), links: [] } }
    })
  })

  it('adds and removes a link, and keeps a deck’s last fifty, the oldest going first', () => {
    const decks = new ArtefactDecks(memory())
    expect(decks.addLink('/work/none', link(1))).toBeUndefined()
    decks.pushed('/work/deck', push(1))
    for (let n = 1; n <= MAX_LINKS_PER_DECK + 1; n++) decks.addLink('/work/deck', link(n))
    const links = decks.get('/work/deck')!.links
    expect(links).toHaveLength(MAX_LINKS_PER_DECK)
    expect(links[0]).toEqual(link(2))
    expect(links.at(-1)).toEqual(link(MAX_LINKS_PER_DECK + 1))
    expect(decks.removeLink('/work/deck', 't2')!.links[0]).toEqual(link(3))
    expect(decks.removeLink('/work/none', 't3')).toBeUndefined()
  })

  it('keeps five hundred decks, the one pushed longest ago going first, never the one written', () => {
    const decks = new ArtefactDecks(memory())
    // Written out of order, so the order of the document is not the age.
    for (let n = MAX_DECKS; n >= 1; n--) decks.pushed(`/work/deck-${n}`, push(n))
    // Older than every deck kept, and still the one being written.
    decks.pushed('/work/new', push(0))
    const all = decks.all()
    expect(Object.keys(all)).toHaveLength(MAX_DECKS)
    expect(all['/work/new']).toBeDefined()
    expect(all['/work/deck-1']).toBeUndefined()
    expect(all['/work/deck-2']).toBeDefined()
  })

  it('reads an unreadable document as empty, says it once, and replaces it at the next write', () => {
    const logged: string[] = []
    const storage = memory('{ not json')
    const decks = new ArtefactDecks(storage, (line) => logged.push(line))
    expect(decks.all()).toEqual({})
    expect(decks.get('/work/deck')).toBeUndefined()
    expect(logged).toHaveLength(1)
    decks.pushed('/work/deck', push(1))
    expect(new ArtefactDecks(storage).get('/work/deck')).toEqual({ ...push(1), links: [] })
    expect(new ArtefactDecks(memory('{"v":2,"decks":{}}'), () => {}).all()).toEqual({})
  })

  it('drops what is no deck and no link, and reads a deck’s last fifty links', () => {
    const many = Array.from({ length: MAX_LINKS_PER_DECK + 5 }, (_, i) => link(i + 1))
    const storage = memory(
      JSON.stringify({
        v: 1,
        decks: {
          '/work/ok': { ...push(1), links: [...many, { tokenId: '', url: 'x' }, 'nonsense'] },
          '/work/no-id': { ...push(2), deckId: '' },
          '/work/no-version': { ...push(3), version: 'three' },
          '/work/null': null
        }
      })
    )
    const all = new ArtefactDecks(storage).all()
    expect(Object.keys(all)).toEqual(['/work/ok'])
    expect(all['/work/ok']!.links).toEqual(many.slice(-MAX_LINKS_PER_DECK))
  })

  it('writes the file owner-only through a rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clave-artefact-decks-'))
    dirs.push(dir)
    const file = join(dir, 'data', 'artefact-decks.json')
    const decks = new ArtefactDecks(fileLinksStorage(file))
    decks.pushed('/work/deck', push(1))
    decks.addLink('/work/deck', link(1))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dir, 'data'))).toEqual(['artefact-decks.json'])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      v: 1,
      decks: { '/work/deck': { ...push(1), links: [link(1)] } }
    })
    expect(new ArtefactDecks(fileLinksStorage(file)).get('/work/deck')!.links).toEqual([link(1)])
  })
})
