import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtefactLinks, MAX_LINKS, fileLinksStorage, type LinksStorage } from './links'

/** The links between sessions and artefacts (PRDCT-4472). */
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
const link = (n: number): { target: string; page: string; title: string; openedAt: string } => ({
  target: `/work/deck-${n}`,
  page: `/work/deck-${n}/index.html`,
  title: `deck-${n}`,
  openedAt: new Date(Date.UTC(2026, 10, 1) + n * 1000).toISOString()
})

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('the artefact links', () => {
  it('sets, gets, lists and removes a session link in a version 1 document', () => {
    const storage = memory()
    const links = new ArtefactLinks(storage)
    expect(links.get('s1')).toBeUndefined()
    links.set('s1', link(1))
    links.set('s2', link(2))
    expect(links.get('s1')).toEqual(link(1))
    expect(JSON.parse(storage.text!)).toEqual({ v: 1, artefacts: { s1: link(1), s2: link(2) } })
    links.set('s1', link(3))
    expect(links.all()).toEqual({ s1: link(3), s2: link(2) })
    links.remove('s1')
    links.remove('nobody')
    expect(links.all()).toEqual({ s2: link(2) })
  })

  it('reads an unreadable document as empty, says it once, and replaces it at the next write', () => {
    const logged: string[] = []
    const storage = memory('{ not json')
    const links = new ArtefactLinks(storage, (line) => logged.push(line))
    expect(links.all()).toEqual({})
    expect(links.get('s1')).toBeUndefined()
    expect(logged).toHaveLength(1)
    links.set('s1', link(1))
    expect(JSON.parse(storage.text!)).toEqual({ v: 1, artefacts: { s1: link(1) } })
    expect(new ArtefactLinks(memory('{"v":2,"artefacts":{}}'), () => {}).all()).toEqual({})
  })

  it('keeps at most 500 links, the oldest by openedAt going first', () => {
    const links = new ArtefactLinks(memory())
    // Written out of order, so the order of the document is not the age.
    for (let n = MAX_LINKS; n >= 1; n--) links.set(`s${n}`, link(n))
    links.set('s-new', link(MAX_LINKS + 1))
    const all = links.all()
    expect(Object.keys(all)).toHaveLength(MAX_LINKS)
    expect(all.s1).toBeUndefined()
    expect(all.s2).toEqual(link(2))
    expect(all['s-new']).toEqual(link(MAX_LINKS + 1))
  })

  it('over the bound, lets the links nobody spares go first, oldest first', () => {
    const links = new ArtefactLinks(memory())
    const spared = new Set(['s-live'])
    const spare = (id: string): boolean => spared.has(id)
    // The spared link is the oldest of all, then 500 unspared ones.
    links.set('s-live', link(0), spare)
    for (let n = 1; n <= MAX_LINKS; n++) links.set(`s${n}`, link(n), spare)
    const all = links.all()
    expect(Object.keys(all)).toHaveLength(MAX_LINKS)
    expect(all['s-live']).toEqual(link(0))
    expect(all.s1).toBeUndefined()
    expect(all.s2).toEqual(link(2))
    expect(all[`s${MAX_LINKS}`]).toEqual(link(MAX_LINKS))
  })

  it('evicts a spared link, oldest first, only when every link left is spared', () => {
    const links = new ArtefactLinks(memory())
    const spare = (): boolean => true
    for (let n = 1; n <= MAX_LINKS + 1; n++) links.set(`s${n}`, link(n), spare)
    const all = links.all()
    expect(Object.keys(all)).toHaveLength(MAX_LINKS)
    expect(all.s1).toBeUndefined()
    expect(all.s2).toEqual(link(2))
    expect(all[`s${MAX_LINKS + 1}`]).toEqual(link(MAX_LINKS + 1))
  })

  it('never evicts the link being set, even the oldest and unspared', () => {
    const links = new ArtefactLinks(memory())
    const spare = (id: string): boolean => id !== 's-set'
    for (let n = 1; n <= MAX_LINKS; n++) links.set(`s${n}`, link(n), spare)
    // Older than every link in the document, and the only one not spared.
    links.set('s-set', link(0), spare)
    const all = links.all()
    expect(Object.keys(all)).toHaveLength(MAX_LINKS)
    expect(all['s-set']).toEqual(link(0))
    expect(all.s1).toBeUndefined()
    // The same without a spare: the age alone would name it, and it stays.
    const plain = new ArtefactLinks(memory())
    for (let n = 1; n <= MAX_LINKS; n++) plain.set(`s${n}`, link(n))
    plain.set('s-set', link(0))
    expect(plain.all()['s-set']).toEqual(link(0))
    expect(plain.all().s1).toBeUndefined()
  })

  it('writes the file owner-only through a rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clave-links-'))
    dirs.push(dir)
    const file = join(dir, 'data', 'artefacts.json')
    const links = new ArtefactLinks(fileLinksStorage(file))
    expect(links.all()).toEqual({})
    links.set('s1', link(1))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, artefacts: { s1: link(1) } })
    expect(new ArtefactLinks(fileLinksStorage(file)).get('s1')).toEqual(link(1))
  })
})
