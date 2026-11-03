import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { foldEvents, parseLine, SEEN_LIMIT } from './claude'
import { emptyTally, type Tally } from './ledger'
import { incompleteTail, newCursor, readMore, type FileCursor } from './reader'

const fixture = readFileSync(join(__dirname, 'fixtures', 'session.jsonl'), 'utf8')

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'analytics-reader-'))
  file = join(dir, 'session.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Reads what the file gained and folds it, the way the collector does. */
function step(
  cursor: FileCursor,
  tally: Tally
): { cursor: FileCursor; bytesRead: number; reset: boolean } {
  const r = readMore(cursor)
  foldEvents(r.lines.map(parseLine), tally, r.cursor.seen)
  return { cursor: r.cursor, bytesRead: r.bytesRead, reset: r.reset }
}

describe('readMore', () => {
  it('a missing file gives nothing and leaves the cursor as it was', () => {
    const cursor = newCursor(join(dir, 'absent.jsonl'))
    const r = readMore(cursor)
    expect(r).toEqual({ lines: [], cursor, reset: false, bytesRead: 0 })
  })

  it('two reads over a growing file give the totals of one read, reading only the new bytes', () => {
    const lines = fixture.split('\n')
    // Cut inside msg_A's six rows, so its dedup must hold across the two reads.
    const head = lines.slice(0, 5).join('\n') + '\n'
    const tail = lines.slice(5).join('\n')
    writeFileSync(file, head)
    const growing = emptyTally()
    let s = step(newCursor(file), growing)
    expect(s.bytesRead).toBe(Buffer.byteLength(head))
    appendFileSync(file, tail)
    s = step(s.cursor, growing)
    expect(s.bytesRead).toBe(Buffer.byteLength(tail))
    expect(s.cursor.offset).toBe(Buffer.byteLength(fixture))

    const whole = emptyTally()
    step(newCursor(file), whole)
    expect(growing.tokens).toEqual(whole.tokens)
    expect(growing.messages).toBe(whole.messages)
    expect(growing.messages).toBe(3)
    expect(growing.toolCalls).toBe(whole.toolCalls)
    expect(growing.prompts).toBe(whole.prompts)

    // Nothing new: nothing read.
    expect(readMore(s.cursor).bytesRead).toBe(0)
  })

  it('holds a partial last line and completes it with the next read', () => {
    const line = JSON.stringify({ type: 'user', message: { content: 'hello there' } })
    writeFileSync(file, `${line}\n${line.slice(0, 20)}`)
    const first = readMore(newCursor(file))
    expect(first.lines).toEqual([line])
    expect(first.cursor.partial).toBe(line.slice(0, 20))
    appendFileSync(file, `${line.slice(20)}\n`)
    const second = readMore(first.cursor)
    expect(second.lines).toEqual([line])
    expect(second.cursor.partial).toBe('')
    expect(second.bytesRead).toBe(Buffer.byteLength(line.slice(20)) + 1)
  })

  it('keeps a multi-byte character cut between two reads whole', () => {
    const text = 'Bonjour, ça marche — 日本 🎉'
    const line = JSON.stringify({ type: 'user', message: { content: text } })
    const bytes = Buffer.from(`${line}\n`)
    // Cut in the middle of the 4-byte emoji.
    const emojiAt = bytes.indexOf(Buffer.from('🎉'))
    writeFileSync(file, bytes.subarray(0, emojiAt + 2))
    const first = readMore(newCursor(file))
    expect(first.lines).toEqual([])
    expect(first.cursor.partial).not.toContain('�')
    appendFileSync(file, bytes.subarray(emojiAt + 2))
    const second = readMore(first.cursor)
    expect(second.lines).toEqual([line])
    expect(JSON.parse(second.lines[0]!).message.content).toBe(text)
    expect(second.cursor.offset).toBe(bytes.length)
  })

  it('counts the incomplete tail of a buffer', () => {
    const e = Buffer.from('é') // 2 bytes
    expect(incompleteTail(Buffer.from('ab'))).toBe(0)
    expect(incompleteTail(e)).toBe(0)
    expect(incompleteTail(e.subarray(0, 1))).toBe(1)
    const emoji = Buffer.from('🎉')
    expect(incompleteTail(emoji.subarray(0, 3))).toBe(3)
  })

  it('starts again when the file shrank', () => {
    writeFileSync(file, fixture)
    const tally = emptyTally()
    const first = step(newCursor(file), tally)
    expect(first.cursor.seen.length).toBeGreaterThan(0)
    const line = JSON.stringify({ type: 'user', message: { content: 'a fresh start' } })
    writeFileSync(file, `${line}\n`)
    const r = readMore(first.cursor)
    expect(r.reset).toBe(true)
    expect(r.lines).toEqual([line])
    expect(r.cursor.seen).toEqual([])
    expect(r.cursor.offset).toBe(Buffer.byteLength(line) + 1)
  })

  it(`remembers the last ${SEEN_LIMIT} message ids, newest last`, () => {
    const rows = Array.from({ length: 70 }, (_, i) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(Date.UTC(2026, 9, 1, 9, i)).toISOString(),
        message: {
          id: `msg_${i}`,
          model: 'claude-opus-5-5',
          content: [],
          usage: { output_tokens: 1 }
        }
      })
    )
    writeFileSync(file, rows.join('\n') + '\n')
    const tally = emptyTally()
    const s = step(newCursor(file), tally)
    expect(s.cursor.seen).toHaveLength(SEEN_LIMIT)
    expect(s.cursor.seen[0]).toBe('msg_6')
    expect(s.cursor.seen[SEEN_LIMIT - 1]).toBe('msg_69')
    expect(tally.messages).toBe(70)
  })
})
