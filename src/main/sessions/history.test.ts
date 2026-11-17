import { describe, expect, it } from 'vitest'
import type { HistoryItem, SessionEvent } from '../../shared/session-model'
import { HISTORY_PAGE_MAX, pageHistory, pageWindow } from './history'

const item = (event: SessionEvent): HistoryItem => ({ event })
/** A turn: the reader's message, an answer, and `tools` calls each answered. */
function turn(n: number, tools = 0): HistoryItem[] {
  const calls = Array.from({ length: tools }, (_, i) => `t${n}-${i}`)
  return [
    item({ type: 'user_message', text: `q${n}` }),
    item({ type: 'assistant_text', delta: `a${n}`, final: true }),
    ...calls.map((id) => item({ type: 'tool_call', id, name: 'Read', input: {} })),
    ...calls.map((id) => item({ type: 'tool_result', id, output: 'ok' }))
  ]
}
/** Every page from the newest back, the way a view reads them. */
function allPages(items: HistoryItem[], limit: number): HistoryItem[][] {
  const pages: HistoryItem[][] = []
  let before: number | null | undefined
  do {
    const page = pageHistory(items, before ?? undefined, limit)
    pages.unshift(page.items)
    before = page.before
  } while (before !== null)
  return pages
}
/** A page that splits a pair: a call or a result whose partner is on another page. */
function splitsAPair(page: HistoryItem[]): boolean {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const { event } of page) {
    if (event.type === 'tool_call') calls.add(event.id)
    if (event.type === 'tool_result') results.add(event.id)
  }
  return [...calls].some((id) => !results.has(id)) || [...results].some((id) => !calls.has(id))
}

describe('conversation history pages', () => {
  it('hands a short past over whole, with nothing older', () => {
    const items = [...turn(0), ...turn(1)]
    expect(pageHistory(items)).toEqual({ items, before: null })
    expect(pageHistory([])).toEqual({ items: [], before: null })
  })
  it('starts at the end and begins each page at a turn', () => {
    const items = Array.from({ length: 50 }, (_, n) => turn(n)).flat()
    const page = pageHistory(items, undefined, 11)
    expect(page.items.at(-1)).toBe(items.at(-1))
    expect(page.items[0].event.type).toBe('user_message')
    expect(page.items.length).toBeGreaterThanOrEqual(11)
    expect(page.before).toBe(items.length - page.items.length)
  })
  it('reads back to the first event exactly once, in order', () => {
    const items = Array.from({ length: 40 }, (_, n) => turn(n, n % 4)).flat()
    const pages = allPages(items, 17)
    expect(pages.length).toBeGreaterThan(3)
    expect(pages.flat()).toEqual(items)
  })
  it('never splits a tool call from its result across two pages', () => {
    // Results arrive long after their calls: one call's pair spans two turns.
    const items: HistoryItem[] = [
      ...turn(0),
      item({ type: 'tool_call', id: 'slow', name: 'Bash', input: {} }),
      ...turn(1, 3),
      ...turn(2, 3),
      item({ type: 'tool_result', id: 'slow', output: 'done' }),
      ...Array.from({ length: 10 }, (_, n) => turn(n + 3, 2)).flat()
    ]
    for (const limit of [3, 5, 8, 13])
      for (const page of allPages(items, limit)) expect(splitsAPair(page)).toBe(false)
  })
  it('pages one very long turn by its steps rather than handing it over whole', () => {
    const items = [
      ...turn(0),
      item({ type: 'user_message', text: 'a long task' }),
      ...Array.from({ length: 300 }, (_, i) => [
        item({ type: 'assistant_text', delta: `step ${i}`, final: true }),
        item({ type: 'tool_call', id: `s${i}`, name: 'Edit', input: {} }),
        item({ type: 'tool_result', id: `s${i}`, output: 'ok' })
      ]).flat()
    ]
    const page = pageHistory(items, undefined, 30)
    expect(page.items.length).toBeLessThan(60)
    expect(splitsAPair(page.items)).toBe(false)
    expect(allPages(items, 30).flat()).toEqual(items)
  })
  it('never cuts inside a turn that ends interrupted, which marks the message before it', () => {
    const items = [
      ...turn(0),
      item({ type: 'user_message', text: 'stopped' }),
      ...Array.from({ length: 40 }, (_, i) => [
        item({ type: 'assistant_text', delta: `step ${i}`, final: true })
      ]).flat(),
      item({ type: 'turn_interrupted' })
    ]
    for (const page of allPages(items, 10)) {
      const interrupted = page.findIndex(({ event }) => event.type === 'turn_interrupted')
      if (interrupted >= 0)
        expect(page.slice(0, interrupted).some(({ event }) => event.type === 'user_message')).toBe(
          true
        )
    }
  })
  it('bounds what one ask may take, and survives a cursor past the end', () => {
    const items = Array.from({ length: 2000 }, (_, n) => turn(n)).flat()
    expect(pageHistory(items, undefined, 1e9).items.length).toBeLessThanOrEqual(
      HISTORY_PAGE_MAX * 2
    )
    expect(pageHistory(items, items.length + 50, 10).items.at(-1)).toBe(items.at(-1))
  })
  it('never begins a page inside a streamed message (PRDCT-4666)', () => {
    const streamed = [
      item({ type: 'user_message', text: 'q' }),
      ...['a', 'b', 'c', 'd'].map((delta) => item({ type: 'assistant_text', delta, final: false })),
      item({ type: 'assistant_text', delta: '', final: true })
    ]
    // One long turn: only steps can begin a page, and a limit of 2 lands on a delta.
    const items = [...turn(0), ...streamed, ...streamed.slice(1), ...streamed.slice(1)]
    for (const limit of [1, 2, 3, 4])
      for (const page of allPages(items, limit)) {
        const first = page[0].event
        const index = items.indexOf(page[0])
        const previous = items[index - 1]?.event
        if (first.type === 'assistant_text' && previous?.type === 'assistant_text')
          expect(previous.final).toBe(true)
      }
  })
})

/** A conversation as a file of items, for `pageWindow`. */
const asFile = (items: HistoryItem[]): { length: number; slice: typeof items.slice } => ({
  length: items.length,
  slice: (start, end) => items.slice(start, end)
})
/** Every page from the newest back, through `pageWindow`. */
function allWindowPages(items: HistoryItem[], limit: number): HistoryItem[][] {
  const pages: HistoryItem[][] = []
  let end = items.length
  for (let guard = 0; guard < items.length + 1; guard++) {
    const page = pageWindow(asFile(items), end, limit)
    pages.unshift(page.items)
    if (page.start === 0) return pages
    expect(page.start).toBeLessThan(end)
    end = page.start
  }
  throw new Error('pageWindow did not terminate')
}

describe('conversation history pages read from a file by window (PRDCT-4666)', () => {
  const longTurn = (n: number, steps: number): HistoryItem[] => [
    item({ type: 'user_message', text: `long ${n}` }),
    ...Array.from({ length: steps }, (_, i) => [
      item({ type: 'assistant_text', delta: `step ${i}`, final: true }),
      item({ type: 'tool_call', id: `l${n}-${i}`, name: 'Edit', input: {} }),
      item({ type: 'tool_result', id: `l${n}-${i}`, output: 'ok' })
    ]).flat()
  ]
  const conversations: Record<string, HistoryItem[]> = {
    'short turns': Array.from({ length: 50 }, (_, n) => turn(n, n % 3)).flat(),
    'a tool pair astride the target': [
      ...turn(0),
      item({ type: 'tool_call', id: 'slow', name: 'Bash', input: {} }),
      ...turn(1, 3),
      ...turn(2, 3),
      item({ type: 'tool_result', id: 'slow', output: 'done' }),
      ...Array.from({ length: 10 }, (_, n) => turn(n + 3, 2)).flat()
    ],
    'an interrupted turn': [
      ...turn(0),
      item({ type: 'user_message', text: 'stopped' }),
      ...Array.from({ length: 40 }, (_, i) =>
        item({ type: 'assistant_text', delta: `step ${i}`, final: true })
      ),
      item({ type: 'turn_interrupted' }),
      ...turn(1)
    ],
    'one long turn paged by its steps': [...turn(0), ...longTurn(1, 120)]
  }
  for (const [name, items] of Object.entries(conversations))
    it(`answers what pageHistory does on ${name}`, () => {
      for (const limit of [3, 7, 13, 30])
        for (let end = 0; end <= items.length; end++) {
          const reference = pageHistory(items, end, limit)
          const windowed = pageWindow(asFile(items), end, limit)
          expect(windowed.items).toEqual(reference.items)
          expect(windowed.start).toBe(reference.before ?? 0)
        }
    })
  it('never separates a call from its result across windows, and terminates', () => {
    const items = [
      ...turn(0),
      item({ type: 'tool_call', id: 'far', name: 'Bash', input: {} }),
      ...Array.from({ length: 1000 }, (_, i) =>
        item({ type: 'assistant_text', delta: `step ${i}`, final: true })
      ),
      item({ type: 'tool_result', id: 'far', output: 'done' }),
      ...longTurn(1, 400),
      ...Array.from({ length: 30 }, (_, n) => turn(n + 2, 2)).flat()
    ]
    // Several windows long, and the far pair wider than one window.
    expect(items.length).toBeGreaterThan(2 * 800)
    for (const limit of [5, 40]) {
      const pages = allWindowPages(items, limit)
      expect(pages.flat()).toEqual(items)
      for (const page of pages) expect(splitsAPair(page)).toBe(false)
    }
  })
})
