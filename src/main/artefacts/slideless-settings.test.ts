import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileLinksStorage, type LinksStorage } from './links'
import { MAX_ORIGIN, normalOrigin, SlidelessSettings } from './slideless-settings'

/** The machine's « New links go to » and the one form an origin is compared in (PRDCT-4266). */
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

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('an origin in its normal form', () => {
  it('lowercases the scheme and the host, drops the default port and the trailing slash', () => {
    expect(normalOrigin('HTTPS://Decks.Example.TEST/')).toBe('https://decks.example.test')
    expect(normalOrigin('https://decks.example.test:443')).toBe('https://decks.example.test')
    expect(normalOrigin('http://cloud.example.test:80/')).toBe('http://cloud.example.test')
    expect(normalOrigin('http://127.0.0.1:3400/')).toBe('http://127.0.0.1:3400')
    expect(normalOrigin('  https://cloud.example.test:8443//  ')).toBe(
      'https://cloud.example.test:8443'
    )
  })

  it('keeps a path a site is served under, and nothing of a user, a query or a fragment', () => {
    expect(normalOrigin('https://cloud.example.test/Decks/')).toBe(
      'https://cloud.example.test/Decks'
    )
    expect(normalOrigin('https://someone:secret@decks.example.test/?a=1#top')).toBe(
      'https://decks.example.test'
    )
  })

  it('only trims a value that is no http(s) address', () => {
    expect(normalOrigin('decks.example.test/')).toBe('decks.example.test')
    expect(normalOrigin('file:///srv/decks/')).toBe('file:///srv/decks')
  })
})

describe('the Slideless settings document', () => {
  it('names no site at first, then the one written, in normal form', () => {
    const storage = memory()
    const settings = new SlidelessSettings(storage)
    expect(settings.newLinksSite()).toBeNull()
    settings.setNewLinksSite('HTTPS://Decks.Example.test/')
    expect(settings.newLinksSite()).toBe('https://decks.example.test')
    expect(JSON.parse(storage.text!)).toEqual({ v: 1, newLinksSite: 'https://decks.example.test' })
    settings.setNewLinksSite(null)
    expect(settings.newLinksSite()).toBeNull()
    expect(JSON.parse(storage.text!)).toEqual({ v: 1, newLinksSite: null })
  })

  it('reads an unreadable document as empty, says it once, and replaces it at the next write', () => {
    const logged: string[] = []
    const storage = memory('{ not json')
    const settings = new SlidelessSettings(storage, (line) => logged.push(line))
    expect(settings.newLinksSite()).toBeNull()
    expect(settings.newLinksSite()).toBeNull()
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('read as empty')
    settings.setNewLinksSite('http://127.0.0.1:3400')
    expect(settings.newLinksSite()).toBe('http://127.0.0.1:3400')
    for (const text of [
      '{"v":2,"newLinksSite":"https://decks.example.test"}',
      '{"v":1,"newLinksSite":42}',
      `{"v":1,"newLinksSite":"https://${'a'.repeat(MAX_ORIGIN)}.example.test"}`
    ])
      expect(new SlidelessSettings(memory(text), () => {}).newLinksSite()).toBeNull()
  })

  it('writes the file owner-only through a rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clave-slideless-settings-'))
    dirs.push(dir)
    const file = join(dir, 'data', 'slideless-settings.json')
    new SlidelessSettings(fileLinksStorage(file)).setNewLinksSite('https://decks.example.test')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      v: 1,
      newLinksSite: 'https://decks.example.test'
    })
    // Nothing left of the write but the file itself.
    expect(readdirSync(join(dir, 'data'))).toEqual(['slideless-settings.json'])
    expect(new SlidelessSettings(fileLinksStorage(file)).newLinksSite()).toBe(
      'https://decks.example.test'
    )
  })
})
