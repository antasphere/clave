import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { KEEP_REMOTE_DECKS, cacheRemoteDeck, pruneServerDecks, safeSegment } from './remote-decks'
import { MAX_TEMPLATE_BYTES } from './deck'

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-decks-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const inside = (file: string): boolean => {
  const rel = path.relative(root, file)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

describe('cacheRemoteDeck', () => {
  it('writes the page under the server and run folders', () => {
    const file = cacheRemoteDeck(root, 'srv-1', 'run-1', '<html>a</html>')
    expect(file).toBe(path.join(root, 'srv-1', 'run-1', 'index.html'))
    expect(fs.readFileSync(file, 'utf8')).toBe('<html>a</html>')
  })
  it('keeps a hostile server id inside the root, in a sanitized folder', () => {
    const file = cacheRemoteDeck(root, '../x', '../../etc', 'page')
    expect(inside(file)).toBe(true)
    expect(path.relative(root, file).split(path.sep)[0]).toBe('.._x')
    for (const raw of ['..', '.', '', '/']) {
      const f = cacheRemoteDeck(root, raw, raw, 'page')
      expect(inside(f)).toBe(true)
    }
  })
  it('names a dot or empty id by a hash, never by the dot itself', () => {
    expect(safeSegment('..')).toMatch(/^[0-9a-f]{16}$/)
    expect(safeSegment('.')).not.toBe(safeSegment('..'))
    expect(safeSegment('')).toMatch(/^[0-9a-f]{16}$/)
    expect(safeSegment('a/b c')).toBe('a_b_c')
  })
  it('refuses a page over the size bound and writes nothing', () => {
    const big = 'x'.repeat(MAX_TEMPLATE_BYTES + 1)
    expect(() => cacheRemoteDeck(root, 's', 'r', big)).toThrow(/larger/)
    expect(fs.existsSync(path.join(root, 's'))).toBe(false)
  })
  it('counts the bound in UTF-8 bytes', () => {
    const wide = 'é'.repeat(MAX_TEMPLATE_BYTES / 2 + 1)
    expect(() => cacheRemoteDeck(root, 's', 'r', wide)).toThrow(/larger/)
  })
  it('leaves no temporary file and overwrites the same ids in place', () => {
    const first = cacheRemoteDeck(root, 's', 'r', 'one')
    const second = cacheRemoteDeck(root, 's', 'r', 'two')
    expect(second).toBe(first)
    expect(fs.readFileSync(second, 'utf8')).toBe('two')
    expect(fs.readdirSync(path.dirname(second))).toEqual(['index.html'])
  })
})

describe('the cache of a server’s pages is bounded (round 1, Note 4)', () => {
  /** Write a run's page and date it `minutes` after a fixed origin, so the
   *  age order the prune reads is explicit, not the clock's resolution. */
  const dated = (server: string, run: string, minutes: number): void => {
    const file = cacheRemoteDeck(root, server, run, `<html>${run}</html>`)
    const at = new Date(Date.UTC(2026, 0, 1) + minutes * 60_000)
    fs.utimesSync(file, at, at)
  }
  const runsOf = (server: string): string[] => fs.readdirSync(path.join(root, server)).sort()
  const name = (i: number): string => `run-${String(i).padStart(2, '0')}`

  it('keeps the newest 40 pages per server and removes the oldest', () => {
    expect(KEEP_REMOTE_DECKS).toBe(40)
    for (let i = 1; i <= 43; i++) dated('srv', name(i), i)
    // The 44th write, the newest of all (its mtime is now).
    cacheRemoteDeck(root, 'srv', name(44), '<html>44</html>')
    const kept = runsOf('srv')
    expect(kept).toHaveLength(40)
    for (let i = 1; i <= 4; i++) expect(kept).not.toContain(name(i))
    for (let i = 5; i <= 44; i++) expect(kept).toContain(name(i))
  })

  it('leaves another server’s folder untouched', () => {
    for (let i = 1; i <= 3; i++) dated('other', name(i), i)
    for (let i = 1; i <= 41; i++) dated('srv', name(i), 100 + i)
    expect(runsOf('srv')).toHaveLength(40)
    expect(runsOf('other')).toEqual([name(1), name(2), name(3)])
  })

  it('does nothing on a missing folder, and does not throw', () => {
    expect(() => pruneServerDecks(path.join(root, 'nowhere'), 1)).not.toThrow()
    expect(fs.existsSync(path.join(root, 'nowhere'))).toBe(false)
  })
})
