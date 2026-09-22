import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  BACKUPS_DIR,
  LAST_RUN_FILE,
  SNAPSHOT_DIRS,
  SNAPSHOT_FILES,
  readLastRun,
  runPrereleaseSnapshot,
  snapshotDecision,
  snapshotDir
} from './prerelease-snapshot'

/**
 * The snapshot exists for one moment: a beta about to rewrite files a stable
 * build will read again. Every rule here is a way the copy could be skipped
 * when it was needed (a marker misread as a beta's) or taken when it was not
 * (every beta launch filling backups/ with copies of itself).
 */
describe('snapshotDecision', () => {
  it('a stable build never snapshots', () => {
    expect(snapshotDecision(null, '1.92.0').snapshot).toBe(false)
    expect(snapshotDecision({ version: '1.91.0', at: '' }, '1.92.0').snapshot).toBe(false)
  })

  it('a beta on a directory last written by a stable build snapshots, named after that stable', () => {
    const d = snapshotDecision({ version: '1.92.0', at: '' }, '2.0.0-beta.1')
    expect(d.snapshot).toBe(true)
    expect(d.fromVersion).toBe('1.92.0')
  })

  it('a beta on a directory with no marker treats it as stable of unknown version', () => {
    const d = snapshotDecision(null, '2.0.0-beta.1')
    expect(d.snapshot).toBe(true)
    expect(d.fromVersion).toBe('stable-unknown')
  })

  it('a beta after a beta does not snapshot again', () => {
    expect(snapshotDecision({ version: '2.0.0-beta.1', at: '' }, '2.0.0-beta.2').snapshot).toBe(
      false
    )
    expect(snapshotDecision({ version: '2.0.0-beta.1', at: '' }, '2.0.0-beta.1').snapshot).toBe(
      false
    )
  })
})

describe('runPrereleaseSnapshot', () => {
  let userData: string

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-snapshot-'))
  })
  afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true })
  })

  function seedStableData(): void {
    fs.writeFileSync(path.join(userData, 'preferences.json'), '{"appIcon":"dark"}')
    fs.writeFileSync(path.join(userData, 'workspace-state.json'), '{"version":1}')
    fs.mkdirSync(path.join(userData, 'session-records'))
    fs.writeFileSync(path.join(userData, 'session-records', 'abc.json'), '{"id":"abc"}')
    // Chromium's, and must not be copied.
    fs.mkdirSync(path.join(userData, 'Cache'))
    fs.writeFileSync(path.join(userData, 'Cache', 'blob'), 'x'.repeat(1000))
  }

  it('copies the state files and directories a stable build wrote, and nothing of Chromium', () => {
    seedStableData()
    fs.writeFileSync(path.join(userData, LAST_RUN_FILE), JSON.stringify({ version: '1.92.0' }))

    const result = runPrereleaseSnapshot(userData, '2.0.0-beta.1', new Date('2026-09-22T10:00:00Z'))

    expect(result).not.toBeNull()
    expect(result!.dir).toBe(path.join(userData, BACKUPS_DIR, '1.92.0'))
    expect(result!.copied.sort()).toEqual(
      ['preferences.json', 'workspace-state.json', 'session-records'].sort()
    )
    expect(fs.readFileSync(path.join(result!.dir, 'preferences.json'), 'utf-8')).toBe(
      '{"appIcon":"dark"}'
    )
    expect(fs.readFileSync(path.join(result!.dir, 'session-records', 'abc.json'), 'utf-8')).toBe(
      '{"id":"abc"}'
    )
    expect(fs.existsSync(path.join(result!.dir, 'Cache'))).toBe(false)
    // The originals are untouched: copy, never move.
    expect(fs.existsSync(path.join(userData, 'preferences.json'))).toBe(true)
  })

  it('stamps the marker with the running version on every launch', () => {
    runPrereleaseSnapshot(userData, '1.92.0', new Date('2026-09-22T10:00:00Z'))
    expect(readLastRun(userData)).toEqual({ version: '1.92.0', at: '2026-09-22T10:00:00.000Z' })
  })

  it('the second beta launch takes no second snapshot', () => {
    seedStableData()
    fs.writeFileSync(path.join(userData, LAST_RUN_FILE), JSON.stringify({ version: '1.92.0' }))
    const first = runPrereleaseSnapshot(userData, '2.0.0-beta.1')
    const second = runPrereleaseSnapshot(userData, '2.0.0-beta.1')
    const third = runPrereleaseSnapshot(userData, '2.0.0-beta.2')
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(third).toBeNull()
    expect(fs.readdirSync(path.join(userData, BACKUPS_DIR))).toEqual(['1.92.0'])
  })

  it('a beta on an empty directory has nothing to snapshot and says so', () => {
    expect(runPrereleaseSnapshot(userData, '2.0.0-beta.1')).toBeNull()
    expect(fs.existsSync(path.join(userData, BACKUPS_DIR))).toBe(false)
    expect(readLastRun(userData)?.version).toBe('2.0.0-beta.1')
  })

  it('going back to stable and then to a beta again snapshots beside the first, never over it', () => {
    seedStableData()
    fs.writeFileSync(path.join(userData, LAST_RUN_FILE), JSON.stringify({ version: '1.92.0' }))
    runPrereleaseSnapshot(userData, '2.0.0-beta.1')
    runPrereleaseSnapshot(userData, '1.92.0')
    const again = runPrereleaseSnapshot(userData, '2.0.0-beta.2')
    expect(again!.dir).toBe(path.join(userData, BACKUPS_DIR, '1.92.0-2'))
    expect(snapshotDir(userData, '1.92.0')).toBe(path.join(userData, BACKUPS_DIR, '1.92.0-3'))
  })

  it('the list covers every file a manager owns and no Chromium directory', () => {
    // A new manager that writes a file the snapshot does not know about is
    // the failure this suite cannot see; at least the list must stay honest.
    const all = [...SNAPSHOT_FILES, ...SNAPSHOT_DIRS]
    expect(new Set(all).size).toBe(all.length)
    for (const name of all) expect(name).not.toMatch(/cache|storage|partitions|gpu/i)
  })
})
