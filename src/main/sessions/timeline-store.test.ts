import { appendFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HistoryItem } from '../../shared/session-model'
import { readTimelineFile, removeTimelineFile, writeTimelineFile } from './timeline-store'

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

  it('keeps the file and its directory private', () => {
    const dir = scratch()
    writeTimelineFile(dir, 'tab-1').close()
    expect(statSync(join(dir, 'tab-1.jsonl')).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    removeTimelineFile(dir, 'tab-1')
    expect(readTimelineFile(dir, 'tab-1')).toBeUndefined()
  })
})
