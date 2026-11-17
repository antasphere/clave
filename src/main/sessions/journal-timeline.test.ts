import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionPosition, TimelinePage } from '@clave/contract/timeline'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HistoryItem, SessionEvent } from '../../shared/session-model'
import { JournalTimeline } from './journal-timeline'
import { SessionTimeline, type Timeline } from './timeline'
import { readTimelineFile, writeTimelineFile, type TimelineFile } from './timeline-store'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-timeline-'))
  dirs.push(dir)
  return join(dir, 'timelines')
}
const filler = 'x'.repeat(2048)
/** Event n of a conversation: a question, then its answer, each about 2 KB. */
const eventAt = (n: number): SessionEvent =>
  n % 2 === 0
    ? { type: 'user_message', text: `q${n} ${filler}` }
    : { type: 'assistant_text', delta: `a${n} ${filler}`, final: true }
/** Every page from the newest back, the way a late reader reads them. */
function readAll(timeline: Timeline, limit: number): TimelinePage['items'] {
  const items: TimelinePage['items'][number][] = []
  let before: number | null | undefined
  for (let guard = 0; guard < 10_000; guard++) {
    const page = timeline.read(before ?? undefined, limit)
    items.unshift(...page.items)
    before = page.before
    if (before === null) return items
  }
  throw new Error('The reader never reached the start')
}
const ignore = (): void => {}

describe('a chat kept whole on disk (PRDCT-4666)', () => {
  it('pages back to the first item of a long run, nothing evicted', () => {
    const dir = scratch()
    const past: HistoryItem[] = Array.from({ length: 300 }, (_, n) => ({ event: eventAt(n) }))
    const script = (timeline: Timeline): void => {
      timeline.initialize()
      for (let n = 300; n < 1800; n++) timeline.capture(eventAt(n), ignore)
    }
    const journal = new JournalTimeline(
      () => past,
      () => writeTimelineFile(dir, 'tab-1')
    )
    script(journal)
    const items = readAll(journal, 200)
    expect(items).toHaveLength(1800)
    expect(items.map((item) => item.event)).toEqual(
      Array.from({ length: 1800 }, (_, n) => eventAt(n))
    )
    expect(items.map((item) => item.position.sequence)).toEqual(
      Array.from({ length: 1800 }, (_, n) => n + 1)
    )
    expect(new Set(items.map((item) => item.position.generation)).size).toBe(1)
    expect(journal.read().truncated).toBe(false)
    expect(journal.read().cursor.sequence).toBe(1800)
    journal.close()

    // The bounded buffer, under the same script, loses most of the live run.
    const bounded = new SessionTimeline(() => past)
    script(bounded)
    expect(readAll(bounded, 200).length).toBeLessThan(1800)
    expect(bounded.read().truncated).toBe(true)
  })

  it('puts a capture made during the seed after the prefix', () => {
    const dir = scratch()
    const positions: SessionPosition[] = []
    let timeline: JournalTimeline
    const past = (): HistoryItem[] => {
      timeline.capture({ type: 'assistant_text', delta: 'during', final: true }, (p) =>
        positions.push(p)
      )
      return [{ event: { type: 'user_message', text: 'past' }, at: 1 }]
    }
    timeline = new JournalTimeline(past, () => writeTimelineFile(dir, 'tab-1'))
    timeline.initialize()
    const page = timeline.read()
    expect(page.items.map((item) => item.event.type)).toEqual(['user_message', 'assistant_text'])
    expect(positions.map((p) => p.sequence)).toEqual([2])
    timeline.close()
  })

  it('truncates and seeds again at a new run of the same tab', () => {
    const dir = scratch()
    const first = new JournalTimeline(
      () => [{ event: { type: 'user_message', text: 'old conversation' } }],
      () => writeTimelineFile(dir, 'tab-1')
    )
    first.initialize()
    first.capture({ type: 'assistant_text', delta: 'old answer', final: true }, ignore)
    const firstGeneration = first.read().cursor.generation
    first.close()
    const second = new JournalTimeline(
      () => [{ event: { type: 'user_message', text: 'new conversation' } }],
      () => writeTimelineFile(dir, 'tab-1')
    )
    second.initialize()
    const page = second.read()
    expect(page.items.map((item) => item.event)).toEqual([
      { type: 'user_message', text: 'new conversation' }
    ])
    expect(page.items[0].position.generation).not.toBe(firstGeneration)
    second.close()
  })

  it('goes on in memory when its file cannot be opened', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const timeline = new JournalTimeline(
        () => [{ event: { type: 'user_message', text: 'replayed' } }],
        () => {
          throw new Error('no space left on device')
        }
      )
      const positions: SessionPosition[] = []
      for (let n = 0; n < 3; n++) timeline.capture(eventAt(n), (p) => positions.push(p))
      expect(positions).toHaveLength(3)
      expect(positions.every((p) => p.sequence > 0)).toBe(true)
      const page = timeline.read()
      expect(page.items.map((item) => item.event)).toEqual([
        { type: 'user_message', text: 'replayed' },
        eventAt(0),
        eventAt(1),
        eventAt(2)
      ])
      expect(page.items.slice(1).map((item) => item.position)).toEqual(positions)
      expect(error).toHaveBeenCalledTimes(1)
      timeline.close()
    } finally {
      error.mockRestore()
    }
  })

  it('goes on in memory when a write fails mid-run, delivering every event once', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // A file whose fourth append fails, as a disk that fills up does.
      const items: HistoryItem[] = []
      let appends = 0
      const file: TimelineFile = {
        get length() {
          return items.length
        },
        append(item) {
          if (++appends === 4) throw new Error('no space left on device')
          items.push(item)
        },
        slice: (start, end) => items.slice(start, end),
        close: vi.fn()
      }
      const timeline = new JournalTimeline(
        () => [],
        () => file
      )
      const delivered: [number, SessionPosition][] = []
      for (let n = 0; n < 3; n++) timeline.capture(eventAt(n), (p) => delivered.push([n, p]))
      const before = timeline.read().cursor.generation
      for (let n = 3; n < 6; n++) timeline.capture(eventAt(n), (p) => delivered.push([n, p]))
      expect(delivered.map(([n]) => n)).toEqual([0, 1, 2, 3, 4, 5])
      expect(delivered.every(([, p]) => p.sequence > 0)).toBe(true)
      const page = timeline.read()
      expect(page.truncated).toBe(true)
      expect(page.items.map((item) => item.event)).toEqual([eventAt(3), eventAt(4), eventAt(5)])
      expect(page.items.map((item) => item.position)).toEqual(delivered.slice(3).map(([, p]) => p))
      expect(page.cursor.generation).not.toBe(before)
      expect(file.close).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalledTimes(1)
      timeline.close()
    } finally {
      error.mockRestore()
    }
  })

  it('reads a finished run whole when stopped, and takes no capture', () => {
    const dir = scratch()
    const live = new JournalTimeline(
      () => [],
      () => writeTimelineFile(dir, 'tab-1')
    )
    live.initialize()
    for (let n = 0; n < 1000; n++) live.capture(eventAt(n), ignore)
    live.close()
    const stopped = JournalTimeline.stopped(readTimelineFile(dir, 'tab-1')!)
    stopped.initialize()
    const items = readAll(stopped, 200)
    expect(items.map((item) => item.event)).toEqual(
      Array.from({ length: 1000 }, (_, n) => eventAt(n))
    )
    expect(stopped.read().truncated).toBe(false)
    expect(() => stopped.capture(eventAt(0), ignore)).toThrow()
    stopped.close()
  })
})
