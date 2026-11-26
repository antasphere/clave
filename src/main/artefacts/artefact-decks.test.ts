import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArtefactShareLink } from '@clave/contract/artefacts'
import {
  ArtefactDecks,
  fileDecksStorage,
  MAX_DECKS,
  MAX_LINKS_PER_DECK,
  recordUnreadable,
  type DeckPush,
  type DecksStorage
} from './artefact-decks'

/** The record of the artefacts' decks and the links Clave made (PRDCT-4266). */
const memory = (initial: string | null = null): DecksStorage & { text: string | null } => {
  const store = {
    file: '/srv/clave-data/artefact-decks.json',
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

  it('refuses every read and every write of a record that is not one, and changes nothing', () => {
    for (const text of ['{ not json', '{"v":2,"decks":{}}', 'null', '[]']) {
      const storage = memory(text)
      const decks = new ArtefactDecks(storage)
      const refused = (call: () => unknown): string => {
        try {
          call()
          return 'no refusal'
        } catch (error) {
          return `${(error as Error).name}: ${(error as Error).message}`
        }
      }
      for (const call of [
        () => decks.all(),
        () => decks.get('/work/deck'),
        () => decks.pushed('/work/deck', push(1)),
        () => decks.addLink('/work/deck', link(1)),
        () => decks.removeLink('/work/deck', 't1')
      ])
        expect(refused(call)).toMatch(
          /^ArtefactRefusal: Clave's record of the shared pages \(\/srv\/clave-data\/artefact-decks\.json\) could not be read: .+\. Nothing was changed\.$/
        )
      expect(storage.text).toBe(text)
    }
    expect(
      recordUnreadable('/srv/clave-data/artefact-decks.json', 'it is not a version 1 record')
    ).toBe(
      "Clave's record of the shared pages (/srv/clave-data/artefact-decks.json) could not be read: it is not a version 1 record. Nothing was changed."
    )
  })

  it('offers no deck for an entry that is none, drops what is no link, and reads a deck’s last fifty links', () => {
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

  it('reads a missing file as an empty record, then writes it owner-only through a rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clave-artefact-decks-'))
    dirs.push(dir)
    const file = join(dir, 'data', 'artefact-decks.json')
    const decks = new ArtefactDecks(fileDecksStorage(file))
    expect(decks.all()).toEqual({})
    expect(existsSync(file)).toBe(false)
    decks.pushed('/work/deck', push(1))
    decks.addLink('/work/deck', link(1))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dir, 'data'))).toEqual(['artefact-decks.json'])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      v: 1,
      decks: { '/work/deck': { ...push(1), links: [link(1)] } }
    })
    expect(new ArtefactDecks(fileDecksStorage(file)).get('/work/deck')!.links).toEqual([link(1)])
  })
})

/**
 * A record file that exists and cannot be read (PRDCT-4266, the rule of the
 * command's own profiles file): an error naming the file, never an empty
 * record, and nothing written over it, since it holds every link's token.
 */
describe('a record file that cannot be read', () => {
  const unreadable = (file: string): RegExp =>
    new RegExp(
      `^Clave's record of the shared pages \\(${file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\) could not be read: .+\\. Nothing was changed\\.$`
    )
  const fileIn = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'clave-artefact-decks-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'data'))
    return join(dir, 'data', 'artefact-decks.json')
  }

  it('refuses the deck view and a push while it cannot be opened, and keeps every deck once it can', () => {
    const file = fileIn()
    const decks = new ArtefactDecks(fileDecksStorage(file))
    decks.pushed('/work/a', push(1))
    decks.addLink('/work/a', link(1))
    decks.pushed('/work/b', push(2))
    const before = readFileSync(file)
    chmodSync(file, 0o000)
    try {
      expect(() => decks.get('/work/a')).toThrow(unreadable(file))
      expect(() => decks.pushed('/work/c', push(3))).toThrow(unreadable(file))
      expect(() => decks.addLink('/work/a', link(2))).toThrow(unreadable(file))
      expect(() => decks.removeLink('/work/a', 't1')).toThrow(unreadable(file))
    } finally {
      chmodSync(file, 0o600)
    }
    expect(readFileSync(file).equals(before)).toBe(true)
    const all = new ArtefactDecks(fileDecksStorage(file)).all()
    expect(Object.keys(all).sort()).toEqual(['/work/a', '/work/b'])
    expect(all['/work/a']!.links).toEqual([link(1)])
  })

  it('refuses reads and writes of a document that is not JSON, the file byte for byte as it was', () => {
    const file = fileIn()
    writeFileSync(file, '{ "v": 1, "decks": { not json', { mode: 0o600 })
    const before = readFileSync(file)
    const decks = new ArtefactDecks(fileDecksStorage(file))
    expect(() => decks.all()).toThrow(unreadable(file))
    expect(() => decks.get('/work/a')).toThrow(unreadable(file))
    expect(() => decks.pushed('/work/a', push(1))).toThrow(unreadable(file))
    expect(() => decks.addLink('/work/a', link(1))).toThrow(unreadable(file))
    expect(() => decks.removeLink('/work/a', 't1')).toThrow(unreadable(file))
    expect(readFileSync(file).equals(before)).toBe(true)
    expect(readdirSync(join(file, '..'))).toEqual(['artefact-decks.json'])
  })

  it('refuses a version 1 record whose decks are no map, on a read and on a write, the file as it was', () => {
    for (const text of ['{"v":1,"decks":"x"}', '{"v":1}']) {
      const file = fileIn()
      writeFileSync(file, text, { mode: 0o600 })
      const decks = new ArtefactDecks(fileDecksStorage(file))
      const sentence = `ArtefactRefusal: ${recordUnreadable(file, 'it is not a version 1 record')}`
      const refused = (call: () => unknown): string => {
        try {
          call()
          return 'no refusal'
        } catch (error) {
          return `${(error as Error).name}: ${(error as Error).message}`
        }
      }
      expect(refused(() => decks.get('/work/a'))).toBe(sentence)
      expect(refused(() => decks.pushed('/work/a', push(1)))).toBe(sentence)
      expect(readFileSync(file, 'utf8')).toBe(text)
    }
  })
})

/**
 * One entry this version cannot read (PRDCT-4266, verifier round 2): one a
 * later release wrote, as a beta sharing the stable app's data folder would.
 * Never offered as a deck, never dropped: every write carries it over as the
 * value it was read, outside the bound, and its own target is refused.
 */
describe('an entry this version cannot read', () => {
  /** `/work/a` as a later release might write it: its version a string, its link `ta`. */
  const later = {
    site: SITE,
    deckId: 'da',
    title: 'deck a',
    version: '2',
    pushedAt: '2026-11-20T10:00:00.000Z',
    links: [{ ...link(1), tokenId: 'ta' }]
  }
  const fileHolding = (decks: Record<string, unknown>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'clave-artefact-decks-'))
    dirs.push(dir)
    const file = join(dir, 'artefact-decks.json')
    writeFileSync(file, `${JSON.stringify({ v: 1, decks }, null, 2)}\n`, { mode: 0o600 })
    return file
  }
  const refusalOf = (call: () => unknown): string => {
    try {
      call()
      return 'no refusal'
    } catch (error) {
      return `${(error as Error).name}: ${(error as Error).message}`
    }
  }

  it('is carried over every write as the value it was read, and is no deck', () => {
    const file = fileHolding({ '/work/a': later })
    const decks = new ArtefactDecks(fileDecksStorage(file))
    expect(decks.all()).toEqual({})
    decks.pushed('/work/b', push(2))
    decks.addLink('/work/b', link(2))
    const written = JSON.parse(readFileSync(file, 'utf8')) as { v: number; decks: object }
    // Byte for byte as its value was: the same JSON, key for key, the token with it.
    expect(JSON.stringify((written.decks as Record<string, unknown>)['/work/a'])).toBe(
      JSON.stringify(later)
    )
    expect(written).toEqual({
      v: 1,
      decks: { '/work/b': { ...push(2), links: [link(2)] }, '/work/a': later }
    })
    expect(Object.keys(new ArtefactDecks(fileDecksStorage(file)).all())).toEqual(['/work/b'])
  })

  it('refuses the view, a push and its links for its own target, and serves every other', () => {
    const file = fileHolding({ '/work/a': later, '/work/b': { ...push(2), links: [link(2)] } })
    const decks = new ArtefactDecks(fileDecksStorage(file))
    const before = readFileSync(file)
    const sentence = `ArtefactRefusal: ${recordUnreadable(
      file,
      'its entry for /work/a is not one this version of Clave can read'
    )}`
    for (const call of [
      () => decks.get('/work/a'),
      () => decks.pushed('/work/a', push(3)),
      () => decks.addLink('/work/a', link(3)),
      () => decks.removeLink('/work/a', 'ta')
    ])
      expect(refusalOf(call)).toBe(sentence)
    expect(readFileSync(file).equals(before)).toBe(true)
    expect(decks.get('/work/b')).toEqual({ ...push(2), links: [link(2)] })
    expect(decks.removeLink('/work/b', 't2')!.links).toEqual([])
    expect(
      (JSON.parse(readFileSync(file, 'utf8')) as { decks: Record<string, unknown> }).decks[
        '/work/a'
      ]
    ).toEqual(later)
  })

  it('is never counted in the bound of five hundred decks, nor evicted by it', () => {
    const storage = memory(JSON.stringify({ v: 1, decks: { '/work/a': later } }))
    const decks = new ArtefactDecks(storage)
    // Five hundred decks this version reads, then one more: the oldest of them goes, never `/work/a`.
    for (let n = 1; n <= MAX_DECKS + 1; n++) decks.pushed(`/work/deck-${n}`, push(n))
    const written = JSON.parse(storage.text!) as { decks: Record<string, unknown> }
    expect(Object.keys(written.decks)).toHaveLength(MAX_DECKS + 1)
    expect(written.decks['/work/a']).toEqual(later)
    expect(written.decks['/work/deck-1']).toBeUndefined()
    expect(Object.keys(decks.all())).toHaveLength(MAX_DECKS)
  })
})
