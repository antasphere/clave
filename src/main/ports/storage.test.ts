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
