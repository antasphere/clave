import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  mkdirSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Claims, KEEP_MS, hashKey } from './claims'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clave-claims-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const KEY = '/w/.clave/workspaces/default.clave::Workspace health'

describe('Claims', () => {
  it('claims an occurrence once: the second server finds it taken, and by whom', () => {
    const a = new Claims({ dir, holder: 'server-a', now: () => 1000 })
    const b = new Claims({ dir, holder: 'server-b', now: () => 1001 })
    const first = a.claim(KEY, 1_700_000_000_000)
    expect(first.kind).toBe('claimed')
    const second = b.claim(KEY, 1_700_000_000_000)
    expect(second).toEqual({ kind: 'taken', by: 'server-a' })
    // Another occurrence of the same routine is free.
    expect(b.claim(KEY, 1_700_000_060_000).kind).toBe('claimed')
    expect(readdirSync(join(dir, hashKey(KEY))).sort()).toEqual([
      '1700000000000.json',
      '1700000060000.json'
    ])
    const written = JSON.parse(readFileSync((first as { file: string }).file, 'utf8'))
    expect(written).toEqual({
      routineKey: KEY,
      occurrence: 1_700_000_000_000,
      holder: 'server-a',
      at: 1000
    })
  })

  it('a manual run claims its own id and never collides with the schedule', () => {
    const a = new Claims({ dir, holder: 'a' })
    expect(a.claim(KEY, 'manual-run-1').kind).toBe('claimed')
    expect(a.claim(KEY, 'manual-run-1').kind).toBe('taken')
    expect(a.claim(KEY, 'manual-run-2').kind).toBe('claimed')
  })

  it('says the folder is unwritable instead of claiming nothing silently', () => {
    const file = join(dir, 'not-a-folder')
    writeFileSync(file, 'x')
    const a = new Claims({ dir: file, holder: 'a' })
    expect(a.probe().ok).toBe(false)
    expect(a.claim(KEY, 1).kind).toBe('unwritable')
  })

  it('prunes claims older than a week and the folders they leave empty', () => {
    let now = 10 * 86_400_000
    const a = new Claims({ dir, holder: 'a', now: () => now })
    a.claim(KEY, 1)
    now += KEEP_MS + 1
    a.claim(KEY, 2)
    // A claim nobody can read, old by its mtime, goes too.
    const junkFolder = join(dir, 'junk')
    mkdirSync(junkFolder)
    const junk = join(junkFolder, 'x.json')
    writeFileSync(junk, '{not json')
    utimesSync(junk, new Date(0), new Date(0))
    expect(a.prune()).toBe(2)
    expect(readdirSync(join(dir, hashKey(KEY)))).toEqual(['2.json'])
    expect(readdirSync(dir)).toEqual([hashKey(KEY)])
  })
})
