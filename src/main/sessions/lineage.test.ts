import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  childrenOf,
  forgetLineage,
  initLineage,
  lineageParents,
  parentOf,
  resetLineageForTests,
  setParent
} from './lineage'

afterEach(() => resetLineageForTests())

describe('the parent link', () => {
  it('answers the opener of a tab, and the tabs an opener opened', () => {
    setParent('child', 'parent')
    setParent('other', 'parent')
    expect(parentOf('child')).toBe('parent')
    expect(parentOf('parent')).toBeNull()
    expect(childrenOf('parent').sort()).toEqual(['child', 'other'])
  })
  it('is forgotten with the tab, and never survives a reset', () => {
    setParent('child', 'parent')
    forgetLineage('child')
    expect(parentOf('child')).toBeNull()
    setParent('child', 'parent')
    resetLineageForTests()
    expect(parentOf('child')).toBeNull()
  })
})

describe('the lineage file (PRDCT-4193)', () => {
  // A tab this Mac opened on a Clave server is known by its full key, and the
  // server's record cannot name an opener of this Mac: the file is the only
  // thing that keeps the reach across a restart and a window reload.
  const DAY = 24 * 60 * 60 * 1000
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })
  const tmpFile = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-lineage-'))
    dirs.push(dir)
    return path.join(dir, 'lineage.json')
  }
  const saved = (file: string): { v: number; parents: Record<string, { parent: string }> } =>
    JSON.parse(fs.readFileSync(file, 'utf8'))

  it('writes every link through, and a fresh load of the same file reads it back', () => {
    const file = tmpFile()
    initLineage(file)
    setParent('clave-owner:session:srv:child', 'caller')
    expect(saved(file)).toMatchObject({
      v: 1,
      parents: { 'clave-owner:session:srv:child': { parent: 'caller' } }
    })
    // The tmp file is renamed over the real one, never left beside it.
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    resetLineageForTests()
    expect(parentOf('clave-owner:session:srv:child')).toBeNull()
    initLineage(file)
    expect(parentOf('clave-owner:session:srv:child')).toBe('caller')
  })
  it('removes a forgotten tab from the file too', () => {
    const file = tmpFile()
    initLineage(file)
    setParent('a', 'p')
    setParent('b', 'p')
    forgetLineage('a')
    expect(Object.keys(saved(file).parents)).toEqual(['b'])
    initLineage(file)
    expect(parentOf('a')).toBeNull()
    expect(parentOf('b')).toBe('p')
  })
  it('drops at load the entries older than thirty days, since a closed server tab leaves no event', () => {
    const file = tmpFile()
    const now = 100 * DAY
    fs.writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        parents: {
          old: { parent: 'p', at: now - 31 * DAY },
          fresh: { parent: 'p', at: now - 29 * DAY },
          broken: { parent: 7, at: now }
        }
      })
    )
    initLineage(file, () => now)
    expect(lineageParents()).toEqual({ fresh: 'p' })
  })
  it('answers every link as a child → opener map, for the window to read', () => {
    setParent('a', 'p')
    setParent('b', 'q')
    expect(lineageParents()).toEqual({ a: 'p', b: 'q' })
  })
  it('never records a tab as its own opener', () => {
    const file = tmpFile()
    initLineage(file)
    setParent('x', 'x')
    expect(parentOf('x')).toBeNull()
    expect(lineageParents()).toEqual({})
    expect(fs.existsSync(file)).toBe(false)
  })
  it.each([
    ['missing', null],
    ['corrupt', '{not json'],
    ['of another version', JSON.stringify({ v: 2, parents: { a: { parent: 'p', at: 1 } } })]
  ])('starts empty from a %s file, and still writes through', (_label, content) => {
    const file = tmpFile()
    if (content !== null) fs.writeFileSync(file, content)
    setParent('stale', 'memory')
    initLineage(file)
    expect(lineageParents()).toEqual({})
    setParent('a', 'p')
    expect(saved(file).parents).toHaveProperty('a')
  })
  it('keeps the link in memory when the file cannot be written', () => {
    const dir = tmpFile()
    // A directory where the file should be: the rename fails.
    fs.mkdirSync(dir)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    initLineage(dir)
    setParent('a', 'p')
    expect(parentOf('a')).toBe('p')
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
  it('stops writing once reset for tests', () => {
    const file = tmpFile()
    initLineage(file)
    setParent('a', 'p')
    const before = fs.readFileSync(file, 'utf8')
    resetLineageForTests()
    setParent('b', 'p')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })
})
