import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { cacheRemoteDeck, safeSegment } from './remote-decks'
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
