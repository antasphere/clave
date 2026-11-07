import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { foldEvents, parseLine } from './claude'
import { blocks, emptyTally, localDay, type Tally } from './ledger'

const fixture = readFileSync(join(__dirname, 'fixtures', 'session.jsonl'), 'utf8')

function fold(text: string): Tally {
  return foldEvents(text.split('\n').map(parseLine), emptyTally())
}

function row(value: unknown): string {
  return JSON.stringify(value)
}

describe('a streamed message', () => {
  // msg_A of the fixture: thinking, text and four tool_use rows sharing one id and one usage.
  const streamed = fixture
    .split('\n')
    .filter((l) => l.includes('"msg_A"'))
    .join('\n')

  it('is six rows in the fixture', () => {
    expect(streamed.split('\n')).toHaveLength(6)
  })

  it('counts its usage once and its four tool calls', () => {
    const t = fold(streamed)
    expect(t.messages).toBe(1)
    expect(t.toolCalls).toBe(4)
    expect(t.tokens).toEqual({
      input: 10,
      cacheWrite5m: 200,
      cacheWrite1h: 300,
      cacheWriteUnsplit: 0,
      cacheRead: 1000,
      output: 50
    })
    expect(t.byModel['claude-opus-5-5']?.messages).toBe(1)
  })

  it('stamps each of its tool calls with the message, not with the row that carried it', () => {
    const t = fold(streamed)
    expect(t.toolStamps).toEqual([
      '2026-10-01T09:00:05.000Z',
      '2026-10-01T09:00:05.000Z',
      '2026-10-01T09:00:05.000Z',
      '2026-10-01T09:00:05.000Z'
    ])
  })
})

describe('a block closed by a streamed message', () => {
  const assistant = (ts: string, id: string, content: unknown[]): string =>
    row({
      type: 'assistant',
      timestamp: ts,
      message: {
        id,
        model: 'claude-opus-5-5',
        content,
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    })

  it('keeps the tool calls its later rows carry, seconds after the message stamp', () => {
    // The message's first row stamps it at 09:00:00; its tool calls arrive on later rows at
    // 09:00:25 and 09:00:31; the next message is 20 minutes away, so the block ends at the
    // message stamp. A call stamped with its own row would fall in no block at all.
    const t = fold(
      [
        assistant('2026-10-01T09:00:00.000Z', 'msg_1', [{ type: 'text', text: 'Reading.' }]),
        assistant('2026-10-01T09:00:25.000Z', 'msg_1', [{ type: 'tool_use', id: 'toolu_a' }]),
        assistant('2026-10-01T09:00:31.000Z', 'msg_1', [{ type: 'tool_use', id: 'toolu_b' }]),
        assistant('2026-10-01T09:20:00.000Z', 'msg_2', [{ type: 'text', text: 'Done.' }])
      ].join('\n')
    )
    expect(t.messages).toBe(2)
    expect(t.toolCalls).toBe(2)
    expect(t.toolStamps).toEqual(['2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z'])
    const list = blocks(t.stamps, 15, t.toolStamps)
    expect(list.map((b) => [b.messages, b.toolCalls])).toEqual([
      [1, 2],
      [1, 0]
    ])
    expect(list.reduce((n, b) => n + b.toolCalls, 0)).toBe(t.toolCalls)
  })

  it('keeps stamping with the message past the bound of the stamps it remembers', () => {
    // Seventy messages, the last one streamed as a text row then a tool row 20 seconds
    // later: the map of message stamps is bounded, and it must let the OLDEST go, never
    // the one it just took, or the calls of every message past the bound fall back on
    // their rows.
    const lines: string[] = []
    for (let i = 0; i < 70; i++) {
      const ts = new Date(Date.UTC(2026, 9, 1, 9, i)).toISOString()
      lines.push(assistant(ts, `msg_${i}`, [{ type: 'text', text: `Step ${i}` }]))
    }
    const last = new Date(Date.UTC(2026, 9, 1, 9, 69, 20)).toISOString()
    lines.push(assistant(last, 'msg_69', [{ type: 'tool_use', id: 'toolu_late' }]))
    const t = fold(lines.join('\n'))
    expect(t.messages).toBe(70)
    expect(t.toolCalls).toBe(1)
    expect(t.toolStamps).toEqual([new Date(Date.UTC(2026, 9, 1, 9, 69)).toISOString()])
  })
})

describe('the whole fixture', () => {
  const t = fold(fixture)

  it('splits the cache writes, keeps an older unsplit row apart, and ignores the synthetic row', () => {
    expect(t.tokens).toEqual({
      input: 18,
      cacheWrite5m: 200,
      cacheWrite1h: 340,
      cacheWriteUnsplit: 700,
      cacheRead: 3100,
      output: 150
    })
    expect(t.byModel['claude-fable-5-1']).toMatchObject({ cacheWriteUnsplit: 700, messages: 1 })
    expect(t.byModel['<synthetic>']).toBeUndefined()
    expect(t.messages).toBe(3)
    expect(t.toolCalls).toBe(5)
    expect(t.skipped).toBe(1)
  })

  it('counts only the prompts a person typed', () => {
    expect(t.prompts).toBe(2)
    expect(t.promptFirstAt).toBe('2026-10-01T09:00:00.000Z')
    expect(t.promptLastAt).toBe('2026-10-02T09:30:00.000Z')
  })

  it('keeps the first and last assistant times, and every distinct stamp', () => {
    expect(t.firstAt).toBe('2026-10-01T09:00:05.000Z')
    expect(t.lastAt).toBe('2026-10-02T09:31:00.000Z')
    // One stamp per counted message, never per streamed row.
    expect(t.stamps).toHaveLength(t.messages)
    expect(t.stamps).not.toContain('2026-10-01T09:11:00.000Z')
  })

  it('buckets by local day', () => {
    const first = t.days[localDay('2026-10-01T09:00:05.000Z')!]!
    const second = t.days[localDay('2026-10-02T09:31:00.000Z')!]!
    expect(first).toMatchObject({ messages: 2, toolCalls: 4, input: 13, output: 130 })
    expect(second).toMatchObject({
      messages: 1,
      toolCalls: 1,
      prompts: 1,
      input: 5,
      cacheWrite1h: 40
    })
    expect(second.byModel['claude-opus-5-5']?.input).toBe(5)
  })
})

describe('a synthetic row', () => {
  it('counts nothing', () => {
    const t = fold(
      row({
        type: 'assistant',
        timestamp: '2026-10-01T10:00:00.000Z',
        message: {
          id: 'msg_x',
          model: '<synthetic>',
          content: [{ type: 'tool_use', id: 'toolu_x' }],
          usage: { input_tokens: 5, output_tokens: 5 }
        }
      })
    )
    expect(t.messages).toBe(0)
    expect(t.toolCalls).toBe(0)
    expect(t.tokens.input).toBe(0)
    expect(t.firstAt).toBeNull()
    expect(t.stamps).toEqual([])
    expect(t.toolStamps).toEqual([])
  })
})

describe('prompts', () => {
  const user = (content: unknown, extra: Record<string, unknown> = {}): string =>
    row({ type: 'user', timestamp: '2026-10-01T10:00:00.000Z', message: { content }, ...extra })

  it('a plain typed sentence is a prompt', () => {
    expect(parseLine(user('Please rename the button'))).toEqual({
      kind: 'prompt',
      timestamp: '2026-10-01T10:00:00.000Z'
    })
    expect(parseLine(user([{ type: 'text', text: 'Rename it' }]))?.kind).toBe('prompt')
  })

  it('a tool result, a reminder, a caveat and a sidechain row are not', () => {
    expect(parseLine(user([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]))).toBeNull()
    expect(parseLine(user('<system-reminder>x</system-reminder>'))).toBeNull()
    expect(parseLine(user('Caveat: generated while running local commands'))).toBeNull()
    expect(parseLine(user('Look at the code', { isSidechain: true }))).toBeNull()
    expect(parseLine(user('[Image #1]'))).toBeNull()
    expect(parseLine(user('   '))).toBeNull()
    expect(parseLine(user('This session is being continued from a previous one'))).toBeNull()
    expect(parseLine(user('Your request was stopped by a safety classifier.'))).toBeNull()
  })
})
