import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { foldEvents, parseLine } from './claude'
import { emptyTally, localDay, type Tally } from './ledger'

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
    expect(t.stamps).toHaveLength(8)
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
