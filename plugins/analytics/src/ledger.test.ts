import { describe, expect, it } from 'vitest'
import { foldEvents, parseLine } from './claude'
import { formatMinutes, formatTokens, formatUsd } from './format'
import {
  activeMinutes,
  blocks,
  dayKey,
  emptyLedger,
  emptyTally,
  groupView,
  sessionView,
  tokensRead,
  wallMinutes,
  workspaceView,
  rangeDays,
  scopeKey,
  type Ledger,
  type SessionRow,
  type Tally
} from './ledger'
import type { PriceTable } from './prices'
import { newCursor } from './reader'

const prices: PriceTable = {
  source: 'test',
  date: '2026-11-03',
  models: {
    'claude-opus-5-5': {
      name: 'Opus',
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite5m: 5,
      cacheWrite1h: 8
    }
  }
}

const at = (minutes: number): string =>
  new Date(Date.UTC(2026, 9, 1, 9, 0) + minutes * 60_000).toISOString()

describe('blocks', () => {
  it('joins messages less than the gap apart and splits at the gap', () => {
    expect(blocks([at(0), at(14), at(28)], 15)).toHaveLength(1)
    const two = blocks([at(0), at(16)], 15)
    expect(two).toHaveLength(2)
    expect(two.map((b) => b.minutes)).toEqual([0, 0])
    const one = blocks([at(28), at(0), at(14), at(14)], 15)
    expect(one).toEqual([{ start: at(0), end: at(28), minutes: 28, messages: 3, toolCalls: 0 }])
  })

  it('counts the tool stamps that fall inside each block, one per tool call', () => {
    const two = blocks([at(0), at(10), at(60), at(65)], 15, [at(0), at(0), at(10), at(65), at(300)])
    expect(two.map((b) => b.toolCalls)).toEqual([3, 1])
    // A tool stamp before every block belongs to none of them.
    expect(blocks([at(10)], 15, [at(0), at(10)]).map((b) => b.toolCalls)).toEqual([1])
  })

  it('active minutes sum the blocks; wall minutes span first to last', () => {
    const list = blocks([at(0), at(10), at(60), at(65)], 15)
    expect(list).toHaveLength(2)
    expect(activeMinutes(list)).toBe(15)
    expect(wallMinutes(at(0), at(65))).toBe(65)
    expect(wallMinutes(null, at(65))).toBe(0)
  })
})

describe('tokens', () => {
  it('tokensRead counts input, both cache writes, the unsplit write and the reads', () => {
    expect(
      tokensRead({
        input: 1,
        cacheWrite5m: 2,
        cacheWrite1h: 3,
        cacheWriteUnsplit: 4,
        cacheRead: 5,
        output: 100
      })
    ).toBe(15)
  })
})

describe('formats', () => {
  it('writes cost, minutes and tokens as the page does', () => {
    expect(formatUsd(12.344)).toBe('$12.34')
    expect(formatUsd(1234.5)).toBe('$1,235')
    expect(formatMinutes(48)).toBe('48 min')
    expect(formatMinutes(65)).toBe('1 h 05')
    expect(formatTokens(312_400)).toBe('312 k')
    expect(formatTokens(98_600_000)).toBe('98.6 M')
    expect(formatTokens(1_510_000_000)).toBe('1.51 B')
  })
})

// ─── A three-session ledger: two in a group, one ungrouped ──────────────────

const NOW = new Date(2026, 9, 10, 12, 0)
/** An ISO time on a local day `daysAgo` before NOW, at `hour:minute`. */
const local = (daysAgo: number, hour: number, minute = 0): string =>
  new Date(2026, 9, 10 - daysAgo, hour, minute).toISOString()

function message(id: string, ts: string, input: number, tools: string[] = []): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      id,
      model: 'claude-opus-5-5',
      content: tools.map((t) => ({ type: 'tool_use', id: t })),
      usage: { input_tokens: input, output_tokens: 10 }
    }
  })
}

function tally(lines: string[]): Tally {
  return foldEvents(lines.map(parseLine), emptyTally())
}

function session(
  id: string,
  group: { id: string; name: string } | null,
  root: Tally,
  extra: Partial<SessionRow> = {}
): SessionRow {
  return {
    id,
    provider: 'claude',
    providerSessionId: `p-${id}`,
    cwd: `/work/${id}`,
    name: `Session ${id}`,
    model: null,
    state: 'idle',
    group,
    workspaceId: 'ws-1',
    createdAt: 1,
    seenAt: '2026-10-10T10:00:00.000Z',
    root: { tally: root, file: { ...newCursor(`/x/${id}.jsonl`), offset: 100 } },
    subagents: [],
    stateSpans: [],
    ...extra
  }
}

function threeSessions(): Ledger {
  const ledger = emptyLedger(15, NOW)
  const g = { id: 'g1', name: 'Theme work' }
  ledger.sessions['a'] = session(
    'a',
    g,
    tally([
      message('a1', local(0, 9), 1_000_000, ['t1']),
      message('a2', local(0, 9, 10), 1_000_000)
    ]),
    {
      state: 'working',
      subagents: [
        {
          id: 'sub1',
          type: 'Explore',
          description: 'Find the reads',
          model: 'opus',
          finished: true,
          tally: tally([message('s1', local(0, 9, 5), 500_000, ['t2', 't3'])]),
          file: newCursor('/x/a/subagents/agent-sub1.jsonl')
        }
      ]
    }
  )
  ledger.sessions['b'] = session(
    'b',
    g,
    tally([message('b1', local(3, 14), 2_000_000), message('b2', local(3, 14, 5), 0)]),
    { state: 'blocked' }
  )
  ledger.sessions['c'] = session('c', null, tally([message('c1', local(20, 8), 4_000_000)]), {
    state: 'ended',
    workspaceId: 'ws-2'
  })
  return ledger
}

describe('views', () => {
  it('a session view puts its own row above its subagents', () => {
    const v = sessionView(threeSessions(), 'a', prices)!
    expect(v.kind).toBe('session')
    // The blocks carry their tool calls: a1 made one, the subagent two.
    expect(v.blocks.map((b) => [b.messages, b.toolCalls])).toEqual([[3, 3]])
    expect(v.rows[0]!.blocks.map((b) => b.toolCalls)).toEqual([1])
    expect(v.rows[1]!.blocks.map((b) => b.toolCalls)).toEqual([2])
    expect(v.live).toEqual([])
    expect(v.published).toBeNull()
    expect(v.rows.map((r) => [r.kind, r.name])).toEqual([
      ['session', 'Session a'],
      ['subagent', 'Explore']
    ])
    expect(v.rows[1]!.description).toBe('Find the reads')
    expect(v.rows[1]!.model).toBe('claude-opus-5-5')
    expect(v.figures.toolCalls).toBe(3)
    expect(v.figures.tokensRead).toBe(2_500_000)
    // (2.5 M input × 4 + 30 output × 20) / 1e6
    expect(v.figures.usd).toBeCloseTo(10.0006, 6)
    expect(v.header).toMatchObject({
      provider: 'claude',
      model: 'claude-opus-5-5',
      folder: 'a',
      state: 'working'
    })
    expect(v.footer).toMatchObject({ files: 2, pricesDate: '2026-11-03', gapMinutes: 15 })
    expect(sessionView(threeSessions(), 'missing', prices)).toBeNull()
  })

  it('a group view holds its two sessions, the subagent folded under its session', () => {
    const v = groupView(threeSessions(), 'g1', prices, 'all', NOW)!
    expect(v.name).toBe('Theme work')
    expect(v.rows.map((r) => r.id).sort()).toEqual(['a', 'b'])
    const a = v.rows.find((r) => r.id === 'a')!
    expect(a.children.map((c) => c.id)).toEqual(['sub1'])
    // Each row carries its own blocks for the swimlane: a's union with its subagent, b's own.
    expect(a.blocks).toHaveLength(1)
    expect(a.blocks[0]).toMatchObject({ messages: 3, toolCalls: 3 })
    expect(v.rows.find((r) => r.id === 'b')!.blocks[0]).toMatchObject({ messages: 2, toolCalls: 0 })
    expect(a.figures.tokensRead).toBe(2_500_000)
    expect(v.figures.tokensRead).toBe(4_500_000)
    expect(v.figures.messages).toBe(5)
    // a: 09:00–09:10, b: 14:00–14:05 three days before; summed agent time.
    expect(v.figures.activeMinutes).toBe(15)
    const empty = groupView(threeSessions(), 'nope', prices, 'all', NOW)
    expect(empty.name).toBe('Group')
    expect(empty.rows).toEqual([])
    expect(empty.header.sessions).toBe(0)
    expect(empty.figures.usd).toBe(0)
  })

  it('a range clips tokens, cost and blocks by local day', () => {
    const today = groupView(threeSessions(), 'g1', prices, 'today', NOW)!
    expect(today.figures.tokensRead).toBe(2_500_000)
    expect(today.figures.activeMinutes).toBe(10)
    expect(today.blocks.every((b) => dayKey(new Date(b.start)) === dayKey(NOW))).toBe(true)
    const week = groupView(threeSessions(), 'g1', prices, '7d', NOW)!
    expect(week.figures.tokensRead).toBe(4_500_000)
    expect(week.figures.usd).toBeCloseTo((4_500_000 * 4 + 50 * 20) / 1e6, 6)
  })

  it('a workspace view holds one card per group and an Ungrouped card', () => {
    const all = workspaceView(threeSessions(), null, prices, 'all', NOW)
    expect(all.cards.map((c) => c.name)).toEqual(['Theme work', 'Ungrouped'])
    expect(all.cards[0]!.counts).toEqual({ working: 1, idle: 0, blocked: 1, ended: 0 })
    expect(all.cards[1]!.counts).toEqual({ working: 0, idle: 0, blocked: 0, ended: 1 })
    expect(all.figures.tokensRead).toBe(8_500_000)

    const ws1 = workspaceView(threeSessions(), 'ws-1', prices, 'all', NOW)
    expect(ws1.cards.map((c) => c.name)).toEqual(['Theme work'])
    // The animation's sessions, every state included, each in its group's lane.
    expect(all.live.map((s) => [s.id, s.groupId, s.groupName, s.state])).toEqual([
      ['a', 'g1', 'Theme work', 'working'],
      ['b', 'g1', 'Theme work', 'blocked'],
      ['c', null, 'Ungrouped', 'ended']
    ])
    expect(all.live[0]!.model).toBe('claude-opus-5-5')

    const month = workspaceView(threeSessions(), null, prices, '30d', NOW)
    expect(month.figures.tokensRead).toBe(8_500_000)
    const week = workspaceView(threeSessions(), null, prices, '7d', NOW)
    expect(week.cards.find((c) => c.id === null)!.figures.tokensRead).toBe(0)
  })

  it('an unpriced model is reported, never priced', () => {
    const ledger = threeSessions()
    ledger.sessions['a']!.root!.tally = tally([
      JSON.stringify({
        type: 'assistant',
        timestamp: local(0, 9),
        message: {
          id: 'z',
          model: 'claude-unknown-9',
          content: [],
          usage: { input_tokens: 7, output_tokens: 3 }
        }
      })
    ])
    ledger.sessions['a']!.subagents = []
    const v = sessionView(ledger, 'a', prices)!
    expect(v.figures.usd).toBe(0)
    expect(v.figures.unpriced).toEqual([{ model: 'claude-unknown-9', tokens: 10 }])
  })
  it('covers exactly today, and exactly the last seven local days', () => {
    const today = rangeDays('today', NOW)!
    expect([...today]).toEqual([dayKey(NOW)])
    const week = rangeDays('7d', NOW)!
    expect(week.size).toBe(7)
    expect(week.has(dayKey(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 6)))).toBe(
      true
    )
    expect(week.has(dayKey(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 7)))).toBe(
      false
    )
    expect(rangeDays('all', NOW)).toBeNull()
  })

  it('keys a scope and reads the deck it was published as', () => {
    expect(scopeKey('session', 'tab 1')).toBe('session:tab 1')
    expect(scopeKey('group', 'g1')).toBe('group:g1')
    expect(scopeKey('workspace', null)).toBe('workspace:-')
    expect(scopeKey('workspace', 'ws-1')).toBe('workspace:ws-1')
    const ledger = threeSessions()
    const deck = {
      deckId: 'deck-1',
      baseUrl: 'https://share.example',
      url: 'https://share.example/p/deck-1',
      version: 2,
      n: 2,
      at: '2026-11-04T10:00:00.000Z',
      title: 'Theme work · Analytics',
      names: false
    }
    ledger.published[scopeKey('group', 'g1')] = deck
    ledger.published[scopeKey('workspace', 'ws-1')] = { ...deck, deckId: 'deck-2' }
    expect(groupView(ledger, 'g1', prices, 'all', NOW).published).toEqual(deck)
    expect(groupView(ledger, 'nope', prices, 'all', NOW).published).toBeNull()
    expect(workspaceView(ledger, 'ws-1', prices, 'all', NOW).published?.deckId).toBe('deck-2')
    expect(workspaceView(ledger, null, prices, 'all', NOW).published).toBeNull()
    expect(sessionView(ledger, 'a', prices)!.published).toBeNull()
  })

  it('counts a session with no workspace stamp in every workspace, as the sidebar shows it', () => {
    const ledger = threeSessions()
    ledger.sessions['d'] = session('d', null, tally([message('d1', local(0, 11), 10_000)]), {
      workspaceId: null
    })
    const one = workspaceView(ledger, 'ws-1', prices, 'all', NOW)
    const names = one.cards.flatMap((card) => card.name)
    expect(one.header.sessions).toBe(3)
    expect(names).toContain('Ungrouped')
    const other = workspaceView(ledger, 'ws-2', prices, 'all', NOW)
    expect(other.header.sessions).toBe(2)
  })
})
