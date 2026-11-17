import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HistoryItem } from '../../shared/session-model'
import {
  readTimelineFile,
  removeTimelineFile,
  sweepTimelineFiles,
  writeTimelineFile
} from './timeline-store'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'timeline-store-'))
  dirs.push(dir)
  return join(dir, 'timelines')
}
const message = (n: number): HistoryItem => ({
  event: { type: 'user_message', text: `message ${n} ✓` },
  at: n
})

describe('a chat run kept on disk, one item per line (PRDCT-4666)', () => {
  it('appends items and reads any range back in order', () => {
    const dir = scratch()
    const file = writeTimelineFile(dir, 'tab-1')
    for (let n = 0; n < 10; n++) file.append(message(n))
    expect(file.length).toBe(10)
    expect(file.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, n) => message(n)))
    expect(file.slice(3, 5)).toEqual([message(3), message(4)])
    expect(file.slice(8, 50)).toEqual([message(8), message(9)])
    expect(file.slice(5, 5)).toEqual([])
    file.close()
  })

  it('reopens a finished run read-only, with the same items', () => {
    const dir = scratch()
    const file = writeTimelineFile(dir, 'tab-1')
    for (let n = 0; n < 5; n++) file.append(message(n))
    file.close()
    const read = readTimelineFile(dir, 'tab-1')!
    expect(read.length).toBe(5)
    expect(read.slice(0, 5)).toEqual(Array.from({ length: 5 }, (_, n) => message(n)))
    expect(() => read.append(message(9))).toThrow()
    read.close()
    expect(readTimelineFile(dir, 'missing')).toBeUndefined()
  })

  it('ignores a trailing partial line, as a crash mid-write leaves', () => {
    const dir = scratch()
    const file = writeTimelineFile(dir, 'tab-1')
    file.append(message(0))
    file.append(message(1))
    file.close()
    appendFileSync(join(dir, 'tab-1.jsonl'), '{"event":{"type":"user_')
    const read = readTimelineFile(dir, 'tab-1')!
    expect(read.length).toBe(2)
    expect(read.slice(0, 2)).toEqual([message(0), message(1)])
    read.close()
  })

  it('truncates the file at a new run', () => {
    const dir = scratch()
    const first = writeTimelineFile(dir, 'tab-1')
    first.append(message(0))
    first.close()
    const second = writeTimelineFile(dir, 'tab-1')
    expect(second.length).toBe(0)
    second.append(message(7))
    second.close()
    expect(readTimelineFile(dir, 'tab-1')!.slice(0, 5)).toEqual([message(7)])
  })

  it('refuses an id that is not a plain name', () => {
    const dir = scratch()
    expect(() => writeTimelineFile(dir, '../escape')).toThrow()
    expect(() => readTimelineFile(dir, 'a/b')).toThrow()
    expect(() => removeTimelineFile(dir, '')).toThrow()
  })

  it('sweeps the run files of sessions that are gone, and nothing else', () => {
    const dir = scratch()
    for (const id of ['kept', 'gone-1', 'gone-2']) writeTimelineFile(dir, id).close()
    writeFileSync(join(dir, 'notes.txt'), 'not a run')
    writeFileSync(join(dir, 'not an id.jsonl'), '')
    mkdirSync(join(dir, 'folder.jsonl'))
    expect(sweepTimelineFiles(dir, new Set()).length).toBe(0)
    expect(readdirSync(dir).sort()).toEqual(
      [
        'folder.jsonl',
        'gone-1.jsonl',
        'gone-2.jsonl',
        'kept.jsonl',
        'not an id.jsonl',
        'notes.txt'
      ].sort()
    )
    expect(sweepTimelineFiles(dir, new Set(['kept'])).sort()).toEqual(['gone-1', 'gone-2'])
    expect(readdirSync(dir).sort()).toEqual(
      ['folder.jsonl', 'kept.jsonl', 'not an id.jsonl', 'notes.txt'].sort()
    )
    expect(sweepTimelineFiles(join(dir, 'missing'), new Set(['kept']))).toEqual([])
  })

  it('reads a run file left readable by others, and makes it private again', () => {
    const dir = scratch()
    const file = writeTimelineFile(dir, 'tab-1')
    file.append(message(0))
    file.close()
    chmodSync(join(dir, 'tab-1.jsonl'), 0o644)
    const read = readTimelineFile(dir, 'tab-1')!
    expect(read.slice(0, 1)).toEqual([message(0)])
    read.close()
    expect(statSync(join(dir, 'tab-1.jsonl')).mode & 0o777).toBe(0o600)
  })

  it('refuses a run file others can write', () => {
    const dir = scratch()
    writeTimelineFile(dir, 'tab-1').close()
    // Writable by the group, by others, or by both.
    for (const mode of [0o666, 0o664, 0o646]) {
      chmodSync(join(dir, 'tab-1.jsonl'), mode)
      expect(() => readTimelineFile(dir, 'tab-1')).toThrow()
    }
  })

  it('makes an existing loose file private when a new run opens it', () => {
    const dir = scratch()
    writeTimelineFile(dir, 'tab-1').close()
    chmodSync(join(dir, 'tab-1.jsonl'), 0o644)
    writeTimelineFile(dir, 'tab-1').close()
    expect(statSync(join(dir, 'tab-1.jsonl')).mode & 0o777).toBe(0o600)
  })

  it('keeps the file and its directory private', () => {
    const dir = scratch()
    writeTimelineFile(dir, 'tab-1').close()
    expect(statSync(join(dir, 'tab-1.jsonl')).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    removeTimelineFile(dir, 'tab-1')
    expect(readTimelineFile(dir, 'tab-1')).toBeUndefined()
  })
})
