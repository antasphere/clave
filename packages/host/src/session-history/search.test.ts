/**
 * The scoped transcript search (PRDCT-1738, slice 2): each scope sees only
 * its own kind of text (a word in a tool input is a Tools hit, never a Human
 * one; thinking is nobody's), sidechains and injected context are skipped,
 * the raw-line gate never loses a match, excerpts window the match, the
 * per-session cap and the abort stop the read, and a missing file
 * contributes nothing rather than throwing.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  codexScopedTexts,
  excerptAround,
  scopedTexts,
  searchLines,
  searchTranscripts
} from './search'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clave-search-test-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const ENTRIES = [
  { type: 'user', timestamp: 't1', message: { content: 'Please fix the login bug' } },
  {
    type: 'user',
    timestamp: 't2',
    message: { content: '<system-reminder>login reminder</system-reminder>' }
  },
  { type: 'user', timestamp: 't3', isSidechain: true, message: { content: 'login in a subagent' } },
  {
    type: 'assistant',
    timestamp: 't4',
    message: {
      content: [
        { type: 'thinking', thinking: 'login thoughts' },
        { type: 'text', text: 'I will fix the login flow now.' }
      ]
    }
  },
  {
    type: 'assistant',
    timestamp: 't5',
    message: {
      content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/src/auth/login.ts' } }]
    }
  },
  {
    type: 'user',
    timestamp: 't6',
    toolUseResult: true,
    message: { content: [{ type: 'tool_result', content: 'export function login() {}' }] }
  },
  { type: 'assistant', timestamp: 't7', message: { content: [{ type: 'text', text: 'Done.' }] } },
  {
    type: 'user',
    timestamp: 't8',
    message: {
      content: [
        { type: 'text', text: '<task-notification>login task finished</task-notification>' }
      ]
    }
  },
  {
    type: 'assistant',
    timestamp: 't9',
    message: {
      content: [
        { type: 'text', text: 'First block mentions login.' },
        { type: 'text', text: 'Second block mentions login too.' }
      ]
    }
  }
]
const LINES = ENTRIES.map((e) => JSON.stringify(e))

describe('scopedTexts', () => {
  it('human = typed text only: no tool results, no sidechains, no injected context', () => {
    expect(scopedTexts(ENTRIES[0], 'human')).toEqual(['Please fix the login bug'])
    expect(scopedTexts(ENTRIES[1], 'human')).toEqual([])
    expect(scopedTexts(ENTRIES[2], 'human')).toEqual([])
    expect(scopedTexts(ENTRIES[5], 'human')).toEqual([])
    expect(scopedTexts(ENTRIES[3], 'human')).toEqual([])
    expect(scopedTexts(ENTRIES[7], 'human')).toEqual([])
  })
  it('agent = assistant text, never thinking', () => {
    expect(scopedTexts(ENTRIES[3], 'agent')).toEqual(['I will fix the login flow now.'])
    expect(scopedTexts(ENTRIES[4], 'agent')).toEqual([])
    expect(scopedTexts(ENTRIES[0], 'agent')).toEqual([])
  })
  it('tools = tool_use name + input, and tool_result content', () => {
    expect(scopedTexts(ENTRIES[4], 'tools')).toEqual(['Read {"file_path":"/src/auth/login.ts"}'])
    expect(scopedTexts(ENTRIES[5], 'tools')).toEqual(['export function login() {}'])
    expect(scopedTexts(ENTRIES[3], 'tools')).toEqual([])
    expect(scopedTexts(ENTRIES[0], 'tools')).toEqual([])
  })
})

const CODEX_ENTRIES = [
  {
    type: 'response_item',
    timestamp: 'c1',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'fix the login page' }]
    }
  },
  {
    type: 'response_item',
    timestamp: 'c2',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '<environment_context>login env</environment_context>' }
      ]
    }
  },
  {
    type: 'response_item',
    timestamp: 'c3',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'The login flow is fixed.' }]
    }
  },
  {
    type: 'response_item',
    timestamp: 'c4',
    payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"grep login"}' }
  },
  {
    type: 'response_item',
    timestamp: 'c5',
    payload: { type: 'custom_tool_call_output', output: 'login.ts: 3 matches' }
  }
]

describe('codexScopedTexts', () => {
  it('human = codex user input_text, injected context excluded', () => {
    expect(codexScopedTexts(CODEX_ENTRIES[0], 'human')).toEqual(['fix the login page'])
    expect(codexScopedTexts(CODEX_ENTRIES[1], 'human')).toEqual([])
    expect(codexScopedTexts(CODEX_ENTRIES[2], 'human')).toEqual([])
  })
  it('agent = codex assistant output_text', () => {
    expect(codexScopedTexts(CODEX_ENTRIES[2], 'agent')).toEqual(['The login flow is fixed.'])
    expect(codexScopedTexts(CODEX_ENTRIES[0], 'agent')).toEqual([])
  })
  it('tools = function/custom calls and their outputs', () => {
    expect(codexScopedTexts(CODEX_ENTRIES[3], 'tools')).toEqual(['shell {"cmd":"grep login"}'])
    expect(codexScopedTexts(CODEX_ENTRIES[4], 'tools')).toEqual(['login.ts: 3 matches'])
    expect(codexScopedTexts(CODEX_ENTRIES[0], 'tools')).toEqual([])
  })
  it('the two extractors never cross: claude lines are nothing to codex and back', () => {
    for (const scope of ['human', 'agent', 'tools'] as const) {
      for (const e of ENTRIES) expect(codexScopedTexts(e, scope)).toEqual([])
      for (const e of CODEX_ENTRIES) expect(scopedTexts(e, scope)).toEqual([])
    }
  })
})

describe('excerptAround', () => {
  it('windows the first case-insensitive match and marks the cuts', () => {
    const long = `${'a'.repeat(200)} The LOGIN page ${'b'.repeat(200)}`
    const ex = excerptAround(long, 'login')
    expect(ex?.startsWith('…')).toBe(true)
    expect(ex?.endsWith('…')).toBe(true)
    expect(ex).toContain('LOGIN page')
    expect(ex?.length).toBeLessThan(200)
    expect(excerptAround('short login', 'login')).toBe('short login')
    expect(excerptAround('nothing here', 'login')).toBeNull()
  })
})

describe('searchLines', () => {
  it('finds each scope in its own entries, once per entry, with timestamps', async () => {
    const human = await searchLines(LINES, 'cc', 'login', ['human'], 10)
    expect(human.hits.map((h) => h.ts)).toEqual(['t1'])
    const agent = await searchLines(LINES, 'cc', 'login', ['agent'], 10)
    // t9 has TWO matching blocks and yields ONE hit: once per entry.
    expect(agent.hits.map((h) => h.ts)).toEqual(['t4', 't9'])
    const tools = await searchLines(LINES, 'cc', 'login', ['tools'], 10)
    expect(tools.hits.map((h) => h.ts)).toEqual(['t5', 't6'])
    expect(tools.hits[0].excerpt).toContain('/src/auth/login.ts')
  })
  it('is case-insensitive and honours the per-session cap', async () => {
    const r = await searchLines(LINES, 'cc', 'LOGIN', ['tools'], 1)
    expect(r.hits).toHaveLength(1)
  })
  it('an abort stops between lines and is reported', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await searchLines(LINES, 'cc', 'login', ['human'], 10, ac.signal)
    expect(r).toEqual({ hits: [], aborted: true })
  })
  it('skips lines that are not JSON', async () => {
    const r = await searchLines(['login but not json', LINES[0]], 'cc', 'login', ['human'], 10)
    expect(r.hits).toHaveLength(1)
  })
  it('toggled scopes search together in one pass, one hit per line', async () => {
    const r = await searchLines(LINES, 'cc', 'login', ['human', 'agent'], 10)
    expect(r.hits.map((h) => [h.ts, h.scope])).toEqual([
      ['t1', 'human'],
      ['t4', 'agent'],
      ['t9', 'agent']
    ])
    // A line matching several toggles yields ONE hit, first toggle wins.
    const twoScoped = JSON.stringify({
      type: 'assistant',
      timestamp: 'tx',
      message: {
        content: [
          { type: 'text', text: 'Reading the login module.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/src/login.ts' } }
        ]
      }
    })
    const both = await searchLines([twoScoped], 'cc', 'login', ['agent', 'tools'], 10)
    expect(both.hits.map((h) => h.scope)).toEqual(['agent'])
    const reversed = await searchLines([twoScoped], 'cc', 'login', ['tools', 'agent'], 10)
    expect(reversed.hits.map((h) => h.scope)).toEqual(['tools'])
  })
  it('no toggles on = nothing searched', async () => {
    const r = await searchLines(LINES, 'cc', 'login', [], 10)
    expect(r.hits).toEqual([])
  })
  it('codex lines answer to the same toggles', async () => {
    const lines = CODEX_ENTRIES.map((e) => JSON.stringify(e))
    const r = await searchLines(lines, 'cx', 'login', ['human', 'agent', 'tools'], 10)
    expect(r.hits.map((h) => [h.ts, h.scope])).toEqual([
      ['c1', 'human'],
      ['c3', 'agent'],
      ['c4', 'tools'],
      ['c5', 'tools']
    ])
  })
})

describe('searchTranscripts (files)', () => {
  it('streams hits per file, in order, and reports what it searched', async () => {
    const a = join(tmp, 'a.jsonl')
    const b = join(tmp, 'b.jsonl')
    writeFileSync(a, LINES.join('\n') + '\n')
    writeFileSync(
      b,
      JSON.stringify({ type: 'user', timestamp: 'b1', message: { content: 'login again' } }) + '\n'
    )
    const batches: number[] = []
    const r = await searchTranscripts(
      [
        { claudeSessionId: 'A', path: a },
        { claudeSessionId: 'gone', path: join(tmp, 'gone.jsonl') },
        { claudeSessionId: 'B', path: b }
      ],
      { query: 'login', scopes: ['human'], onHits: (h) => batches.push(h.length) }
    )
    expect(r.hits.map((h) => h.claudeSessionId)).toEqual(['A', 'B'])
    expect(batches).toEqual([1, 1])
    expect(r.truncated).toBe(false)
    expect(r.filesSearched).toBe(2)
  })
  it('stops at maxHits and says so', async () => {
    const a = join(tmp, 'a.jsonl')
    writeFileSync(a, LINES.join('\n') + '\n')
    const r = await searchTranscripts(
      [
        { claudeSessionId: 'A', path: a },
        { claudeSessionId: 'B', path: a }
      ],
      { query: 'login', scopes: ['tools'], maxHits: 2 }
    )
    expect(r.hits).toHaveLength(2)
    expect(r.truncated).toBe(true)
  })
  it('a blank query searches nothing, even over a file that would match anything', async () => {
    const a = join(tmp, 'a.jsonl')
    writeFileSync(a, LINES.join('\n') + '\n')
    const r = await searchTranscripts([{ claudeSessionId: 'A', path: a }], {
      query: '  ',
      scopes: ['human']
    })
    expect(r).toEqual({ hits: [], filesSearched: 0, truncated: false })
    // And the query is trimmed before matching.
    const t = await searchTranscripts([{ claudeSessionId: 'A', path: a }], {
      query: '  login  ',
      scopes: ['human']
    })
    expect(t.hits).toHaveLength(1)
  })
})
