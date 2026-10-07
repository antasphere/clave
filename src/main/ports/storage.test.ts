import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileStorage, readJson, writeJson } from './storage'
import { tempDataDir } from './testing'

/**
 * The one storage adapter, under both port compositions. Everything here is
 * silent if wrong: a write that is not atomic leaves a truncated file after
 * a kill, a mode that is not applied leaves a credentials file readable by
 * every process of the machine, and a missing file read as an error turns
 * every first boot into a crash.
 */
describe('fileStorage', () => {
  it('reads what it wrote, and null for what is not there', () => {
    const storage = fileStorage(tempDataDir())
    expect(storage.read('nothing.json')).toBeNull()
    storage.write('a.json', '{"x":1}')
    expect(storage.read('a.json')).toBe('{"x":1}')
    expect(storage.pathOf('a.json')).toBe(path.join(storage.pathOf('.'), 'a.json'))
  })

  it('creates the folders, writes through a temp file, and leaves none behind', () => {
    const dir = tempDataDir()
    const storage = fileStorage(dir)
    storage.write('deep/er/file.json', '{}')
    expect(fs.readFileSync(path.join(dir, 'deep/er/file.json'), 'utf-8')).toBe('{}')
    expect(fs.readdirSync(path.join(dir, 'deep/er'))).toEqual(['file.json'])
  })

  it('replaces the document rather than rewriting it in place', () => {
    const dir = tempDataDir()
    const storage = fileStorage(dir)
    storage.write('state.json', '{"v":1}')
    const before = fs.statSync(path.join(dir, 'state.json')).ino
    storage.write('state.json', '{"v":2}')
    // A rename swaps the directory entry for a new file: a reader holding
    // the old one keeps a complete document, and a kill mid-write leaves the
    // old document, never a truncated new one. Rewriting in place keeps the
    // inode.
    expect(fs.statSync(path.join(dir, 'state.json')).ino).not.toBe(before)
    expect(storage.read('state.json')).toBe('{"v":2}')
  })

  it('does not let a stale temp file keep its old mode', () => {
    const dir = tempDataDir()
    const storage = fileStorage(dir)
    fs.writeFileSync(path.join(dir, 'secret.json.tmp'), 'stale', { mode: 0o644 })
    storage.write('secret.json', '{}', { mode: 0o600 })
    expect(fs.statSync(path.join(dir, 'secret.json')).mode & 0o777).toBe(0o600)
  })

  it('applies the mode asked for', () => {
    const dir = tempDataDir()
    const storage = fileStorage(dir)
    storage.write('secret.json', '{}', { mode: 0o600 })
    expect(fs.statSync(path.join(dir, 'secret.json')).mode & 0o777).toBe(0o600)
  })

  it('removes, and removing twice is fine', () => {
    const storage = fileStorage(tempDataDir())
    storage.write('x.json', '1')
    storage.remove('x.json')
    storage.remove('x.json')
    expect(storage.read('x.json')).toBeNull()
  })
})

describe('fileStorage.list', () => {
  it('names the documents directly under a folder, and nothing for a folder that is not there', () => {
    const dir = tempDataDir()
    const storage = fileStorage(dir)
    expect(storage.list('records')).toEqual([])
    storage.write('records/a.json', '1')
    storage.write('records/b.json', '2')
    storage.write('records/nested/c.json', '3')
    fs.writeFileSync(path.join(dir, 'records', 'd.json.tmp'), 'half')
    expect(storage.list('records').sort()).toEqual(['a.json', 'b.json', 'd.json.tmp'])
    expect(storage.list('records/nested')).toEqual(['c.json'])
  })
})

describe('readJson and writeJson', () => {
  it('round-trip a value as 2-space JSON, and read null for a missing or broken document', () => {
    const storage = fileStorage(tempDataDir())
    writeJson(storage, 'doc.json', { v: 1, list: ['a'] })
    expect(storage.read('doc.json')).toBe('{\n  "v": 1,\n  "list": [\n    "a"\n  ]\n}')
    expect(readJson(storage, 'doc.json')).toEqual({ v: 1, list: ['a'] })
    expect(readJson(storage, 'missing.json')).toBeNull()
    storage.write('broken.json', '{not json')
    expect(readJson(storage, 'broken.json')).toBeNull()
  })
})
