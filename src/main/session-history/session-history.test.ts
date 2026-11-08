/**
 * The session history's pure core (PRDCT-1738): the ledger's round trip and
 * its refusal of malformed rows, the fold (one entry per transcript, every
 * group a session lived in, the last row winning scalars, the capture seed
 * never erasing a stamped workspace, closed then re-placed = open), the
 * group match by id or name, and the transcript peek over a fixture tail
 * (title, last prompt, last human timestamp, tool results and injected
 * context excluded, a missing file = not resumable rather than a throw).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WORK_DIGEST_MARKER } from '../../shared/work-digest'
import { SessionLedger, normalizeLedgerRow, type LedgerRow } from './ledger'
import {
  captureEventsToRows,
  foldHistory,
  isTitleHelperConversation,
  TITLE_HELPER_MARKER,
  unknownStems
} from './index'
import { entryInGroup } from '../../shared/history-group-match'
import {
  indexTranscripts,
  locateTranscript,
  peekTranscript,
  PeekCache,
  scanHead,
  scanTail,
  transcriptPath
} from './transcript-peek'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clave-history-test-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function row(over: Partial<LedgerRow>): LedgerRow {
  return {
    v: 1,
    kind: 'placed',
    ts: '2026-08-25T10:00:00.000Z',
    sessionId: 'tab-1',
    claudeSessionId: 'cc-1',
    name: 'first ask',
    cwd: '/tmp/proj',
    mode: 'claude',
    model: null,
    workspaceId: 'ws-1',
    groupId: 'g-1',
    groupName: 'Alpha',
    ...over
  }
}

describe('SessionLedger', () => {
  it('round-trips rows and counts (never drops) malformed lines', () => {
    const ledger = new SessionLedger(join(tmp, 'session-history'))
    ledger.append(row({}))
    ledger.append(row({ kind: 'closed', ts: '2026-08-25T11:00:00.000Z' }))
    writeFileSync(ledger.filePath(), '{"v":1,"kind":"placed"}\nnot json\n', { flag: 'a' })
    const { rows, skippedLines } = ledger.readAll()
    expect(rows.map((r) => r.kind)).toEqual(['placed', 'closed'])
    expect(skippedLines).toBe(2)
  })

  it('an absent file is an empty ledger', () => {
    expect(new SessionLedger(join(tmp, 'nope')).readAll()).toEqual({ rows: [], skippedLines: 0 })
  })

  it('normalizeLedgerRow re-picks fields and refuses the malformed', () => {
    const extra = { ...row({}), smuggled: 'x' } as unknown
    expect(normalizeLedgerRow(extra)).toEqual(row({}))
    expect(normalizeLedgerRow({ ...row({}), kind: 'moved' })).toBeNull()
    expect(normalizeLedgerRow({ ...row({}), mode: 'gemini' })).toBeNull()
    expect(normalizeLedgerRow({ ...row({}), ts: 'yesterday' })).toBeNull()
    expect(normalizeLedgerRow({ ...row({}), sessionId: undefined })).toBeNull()
    expect(normalizeLedgerRow(null)).toBeNull()
  })

  it('a transcript id outside the id alphabet is dropped to null, never stored', () => {
    expect(normalizeLedgerRow({ ...row({}), claudeSessionId: 42 })?.claudeSessionId).toBeNull()
    expect(
      normalizeLedgerRow({ ...row({}), claudeSessionId: '../../etc/passwd' })?.claudeSessionId
    ).toBeNull()
    expect(normalizeLedgerRow({ ...row({}), claudeSessionId: 'cc-1' })?.claudeSessionId).toBe(
      'cc-1'
    )
  })

  it('an empty name is a valid row (the tab may not be titled yet); a huge name is cut, a huge cwd refused', () => {
    expect(normalizeLedgerRow({ ...row({}), name: '' })?.name).toBe('')
    expect(normalizeLedgerRow({ ...row({}), name: 'x'.repeat(5000) })?.name).toHaveLength(512)
    expect(normalizeLedgerRow({ ...row({}), cwd: '/' + 'y'.repeat(5000) })).toBeNull()
  })
})

describe('foldHistory', () => {
  it('one entry per transcript; a terminal (no transcript) is folded away', () => {
    const entries = foldHistory([
      row({}),
      row({ claudeSessionId: null, sessionId: 'term', mode: 'terminal' })
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0].claudeSessionId).toBe('cc-1')
  })

  it('keeps every group the session lived in, first seen first, with the latest name', () => {
    const entries = foldHistory([
      row({ ts: '2026-08-25T10:00:00.000Z' }),
      row({ ts: '2026-08-25T10:30:00.000Z', groupId: 'g-2', groupName: 'Beta' }),
      row({ ts: '2026-08-25T10:40:00.000Z', groupId: 'g-1', groupName: 'Alpha renamed' })
    ])
    expect(entries[0].groups).toEqual([
      { id: 'g-1', name: 'Alpha renamed', firstAt: '2026-08-25T10:00:00.000Z' },
      { id: 'g-2', name: 'Beta', firstAt: '2026-08-25T10:30:00.000Z' }
    ])
  })

  it('the last row wins scalars whatever the input order; closed then re-placed is open', () => {
    const entries = foldHistory([
      row({ ts: '2026-08-25T12:00:00.000Z', name: 'renamed', sessionId: 'tab-2' }),
      row({ ts: '2026-08-25T11:00:00.000Z', kind: 'closed' }),
      row({ ts: '2026-08-25T10:00:00.000Z' })
    ])
    expect(entries[0].name).toBe('renamed')
    expect(entries[0].sessionId).toBe('tab-2')
    expect(entries[0].closedAt).toBeNull()
    expect(entries[0].firstSeenAt).toBe('2026-08-25T10:00:00.000Z')
    expect(entries[0].lastSeenAt).toBe('2026-08-25T12:00:00.000Z')
    const closed = foldHistory([row({}), row({ ts: '2026-08-25T11:00:00.000Z', kind: 'closed' })])
    expect(closed[0].closedAt).toBe('2026-08-25T11:00:00.000Z')
  })

  it('the capture seed never erases a stamped workspace', () => {
    const seed = captureEventsToRows([
      {
        kind: 'session_state',
        ts: '2026-08-22T10:00:00.000Z',
        session: {
          sessionId: 'tab-1',
          name: 'seeded',
          mode: 'claude',
          cwd: '/tmp/proj',
          claudeSessionId: 'cc-1',
          groupId: 'g-0',
          groupName: 'Old'
        }
      },
      { kind: 'message', ts: '2026-08-22T10:01:00.000Z' },
      {
        kind: 'tab_closed',
        ts: '2026-08-22T11:00:00.000Z',
        session: {
          sessionId: 'tab-1',
          name: 'seeded',
          mode: 'claude',
          cwd: '/tmp/proj',
          claudeSessionId: 'cc-1',
          groupId: null,
          groupName: null
        }
      },
      { kind: 'session_state', ts: '2026-08-22T12:00:00.000Z', session: { name: 'no id' } }
    ])
    expect(seed).toHaveLength(2)
    expect(seed[0].workspaceId).toBeNull()
    expect(seed[1].kind).toBe('closed')
    const entries = foldHistory([...seed, row({ ts: '2026-08-25T10:00:00.000Z' })])
    expect(entries[0].workspaceId).toBe('ws-1')
    expect(entries[0].groups.map((g) => g.id)).toEqual(['g-0', 'g-1'])
    // A stamped row carrying no workspace keeps the one already known.
    const kept = foldHistory([row({}), row({ ts: '2026-08-25T11:00:00.000Z', workspaceId: null })])
    expect(kept[0].workspaceId).toBe('ws-1')
  })

  it('entryInGroup matches by id or by name — a relaunched pin keeps its history', () => {
    const [entry] = foldHistory([row({})])
    expect(entryInGroup(entry.groups, { id: 'g-1', name: 'whatever' })).toBe(true)
    expect(entryInGroup(entry.groups, { id: 'g-9', name: 'Alpha' })).toBe(true)
    expect(entryInGroup(entry.groups, { id: 'g-9', name: 'Beta' })).toBe(false)
    const [nameless] = foldHistory([row({ groupName: null })])
    expect(entryInGroup(nameless.groups, { id: 'g-9', name: '' })).toBe(false)
  })

  it('the model sticks: a later row without one keeps the model the session was opened on', () => {
    const [entry] = foldHistory([
      row({ model: 'claude-opus-5' }),
      row({ ts: '2026-08-25T11:00:00.000Z', model: null })
    ])
    expect(entry.model).toBe('claude-opus-5')
  })
})

const TAIL = [
  JSON.stringify({
    type: 'user',
    timestamp: '2026-08-25T09:00:00.000Z',
    message: { content: '<command-name>/clear</command-name>' }
  }),
  JSON.stringify({
    type: 'user',
    timestamp: '2026-08-25T09:01:00.000Z',
    message: { content: [{ type: 'text', text: 'Please fix the login bug' }] }
  }),
  JSON.stringify({ type: 'ai-title', aiTitle: 'Login bug fix' }),
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-25T09:02:00.000Z',
    message: { content: [{ type: 'text', text: 'On it' }] }
  }),
  JSON.stringify({
    type: 'user',
    timestamp: '2026-08-25T09:03:00.000Z',
    toolUseResult: true,
    message: { content: [{ type: 'tool_result', content: 'ok' }] }
  }),
  JSON.stringify({
    type: 'user',
    timestamp: '2026-08-25T09:04:00.000Z',
    isSidechain: true,
    message: { content: 'subagent prompt' }
  }),
  JSON.stringify({
    type: 'user',
    timestamp: '2026-08-25T09:05:00.000Z',
    message: { content: '<system-reminder>injected</system-reminder>' }
  }),
  JSON.stringify({ type: 'last-prompt', lastPrompt: 'Please fix the login bug' }),
  JSON.stringify({
    type: 'user',
    timestamp: '2026-08-25T09:06:00.000Z',
    isMeta: true,
    message: { content: [{ type: 'text', text: 'Base directory for this skill: /x\n\n# /lane' }] }
  }),
  JSON.stringify({
    type: 'user',
    timestamp: '2026-08-25T09:07:00.000Z',
    message: { content: [{ type: 'text', text: '<task-notification>done</task-notification>' }] }
  }),
  'this line is not json'
].join('\n')

describe('the dir encoding', () => {
  it("the shared copy and the contract's pinned copy agree", async () => {
    const { encodeProjectDir } = await import('../../shared/project-dir')
    const { transcriptProjectDirName } =
      await import('../exchange-capture/contract/workstream-events')
    for (const cwd of ['/tmp/proj', '/a/b.c/d-e', '/Users/x/.antasphere/labs']) {
      expect(encodeProjectDir(cwd)).toBe(transcriptProjectDirName(cwd))
    }
  })
})

describe('unknownStems', () => {
  it("lists what the ledger does not know, skipping Claude Code's own helper dir", () => {
    const index = new Map([
      ['-proj-a', new Set(['cc-1', 'cc-2'])],
      ['-', new Set(['helper-1'])],
      ['-proj-b', new Set(['cc-3'])]
    ])
    expect(unknownStems(index, new Set(['cc-1']))).toEqual([
      { dir: '-proj-a', stem: 'cc-2' },
      { dir: '-proj-b', stem: 'cc-3' }
    ])
    expect(unknownStems(index, new Set(['cc-1', 'cc-2', 'cc-3']))).toEqual([])
  })
})

describe('isTitleHelperConversation', () => {
  it("recognizes the app's own tab-title helper by the prompt it sent", () => {
    expect(isTitleHelperConversation(`${TITLE_HELPER_MARKER} based on what the user asked.`)).toBe(
      true
    )
    expect(isTitleHelperConversation(`  ${TITLE_HELPER_MARKER}…`)).toBe(true)
    expect(isTitleHelperConversation('Generate a title for my landing page')).toBe(false)
    expect(isTitleHelperConversation(null)).toBe(false)
  })
  it('skips the work digest’s one-shots too (the card titles of the agent’s working notes)', () => {
    expect(isTitleHelperConversation(`${WORK_DIGEST_MARKER}, so its human knows`)).toBe(true)
  })
})

describe('transcript peek', () => {
  it('scanTail reads the title, the last prompt and the last HUMAN timestamp', () => {
    const scan = scanTail(TAIL)
    expect(scan.title).toBe('Login bug fix')
    expect(scan.lastPrompt).toBe('Please fix the login bug')
    // Not 09:03 (a tool result), not 09:04 (a subagent), not 09:05 (injected),
    // not 09:06 (an isMeta skill body), not 09:07 (a `<`-prefixed notification).
    expect(scan.lastHumanAt).toBe('2026-08-25T09:01:00.000Z')
  })

  it('the last occurrence wins for the title', () => {
    const text = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'first' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'second' })
    ].join('\n')
    expect(scanTail(text).title).toBe('second')
  })

  it('peekTranscript reads only the tail of a large file, dropping the cut line', () => {
    const file = join(tmp, 'big.jsonl')
    const filler = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'x'.repeat(2000) }] }
    })
    const lines = [JSON.stringify({ type: 'ai-title', aiTitle: 'early title' })]
    for (let i = 0; i < 60; i++) lines.push(filler) // ~120 KB of filler
    lines.push(TAIL)
    writeFileSync(file, lines.join('\n') + '\n')
    const peek = peekTranscript(file)
    expect(peek.exists).toBe(true)
    expect(peek.title).toBe('Login bug fix')
    expect(peek.lastPrompt).toBe('Please fix the login bug')
    expect(peek.lastHumanAt).toBe('2026-08-25T09:01:00.000Z')
    expect(peek.sizeBytes).toBeGreaterThan(64 * 1024)
  })

  it('a title outside the first 64 KB is found by the wider second read (the last 1 MB)', () => {
    const file = join(tmp, 'headtitle.jsonl')
    const filler = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'y'.repeat(2000) }] }
    })
    const lines = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-25T08:00:00.000Z',
        message: { content: 'the ask' }
      }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'head title' })
    ]
    for (let i = 0; i < 60; i++) lines.push(filler)
    writeFileSync(file, lines.join('\n') + '\n')
    const peek = peekTranscript(file)
    expect(peek.title).toBe('head title')
    expect(peek.lastHumanAt).toBe('2026-08-25T08:00:00.000Z')
  })

  it('the FIRST cwd and the FIRST timestamp win, even when the break never fires', () => {
    // Two cwd-only records (no timestamp): the early break cannot end the
    // scan, only the first-wins guards keep /a.
    const cwdOnly = [
      JSON.stringify({ type: 'x', cwd: '/a' }),
      JSON.stringify({ type: 'x', cwd: '/b' })
    ].join('\n')
    expect(scanHead(cwdOnly)).toEqual({ cwd: '/a', firstAt: null })
    const tsOnly = [
      JSON.stringify({ type: 'x', timestamp: 't1' }),
      JSON.stringify({ type: 'x', timestamp: 't2' })
    ].join('\n')
    expect(scanHead(tsOnly)).toEqual({ cwd: null, firstAt: 't1' })
  })

  it('a cwd past the first 64 KB is found by the wider second head read', () => {
    const file = join(tmp, 'latecwd.jsonl')
    const filler = JSON.stringify({ type: 'mode', mode: 'default' })
    const lines: string[] = []
    for (let i = 0; i < 3000; i++) lines.push(filler) // ~90 KB of cwd-less records
    lines.push(
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-25T06:00:00.000Z',
        cwd: '/tmp/late-root',
        message: { content: 'hi' }
      })
    )
    lines.push(TAIL)
    writeFileSync(file, lines.join('\n') + '\n')
    expect(peekTranscript(file).cwd).toBe('/tmp/late-root')
  })

  it("scanHead reads the conversation's own cwd and start, first record wins", () => {
    const head = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'no cwd here' }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-25T08:00:00.000Z',
        cwd: '/tmp/real-root',
        message: { content: 'hi' }
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-25T09:00:00.000Z',
        cwd: '/tmp/other',
        message: { content: 'later' }
      }),
      'not json'
    ].join('\n')
    expect(scanHead(head)).toEqual({ cwd: '/tmp/real-root', firstAt: '2026-08-25T08:00:00.000Z' })
    expect(scanHead(JSON.stringify({ cwd: 'relative-not-absolute' }))).toEqual({
      cwd: null,
      firstAt: null
    })
    expect(scanHead('')).toEqual({ cwd: null, firstAt: null })
  })

  it('peekTranscript carries the head fields alongside the tail ones', () => {
    const file = join(tmp, 'head.jsonl')
    writeFileSync(
      file,
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-25T07:00:00.000Z',
        cwd: '/tmp/proj',
        message: { content: 'the ask' }
      }) +
        '\n' +
        TAIL +
        '\n'
    )
    const peek = peekTranscript(file)
    expect(peek.cwd).toBe('/tmp/proj')
    expect(peek.firstAt).toBe('2026-08-25T07:00:00.000Z')
    expect(peek.title).toBe('Login bug fix')
  })

  it('a missing transcript is exists:false, never a throw', () => {
    expect(peekTranscript(join(tmp, 'gone.jsonl')).exists).toBe(false)
    expect(peekTranscript(null).exists).toBe(false)
  })

  it('locateTranscript finds the direct path, else one under another project dir, and refuses a traversal', () => {
    const root = join(tmp, 'projects')
    const direct = transcriptPath(root, '/tmp/proj', 'cc-1')
    mkdirSync(join(root, '-tmp-proj'), { recursive: true })
    writeFileSync(direct, '')
    expect(locateTranscript(root, '/tmp/proj', 'cc-1')).toBe(direct)
    mkdirSync(join(root, '-elsewhere'), { recursive: true })
    writeFileSync(join(root, '-elsewhere', 'cc-2.jsonl'), '')
    expect(locateTranscript(root, '/tmp/proj', 'cc-2')).toBe(join(root, '-elsewhere', 'cc-2.jsonl'))
    expect(locateTranscript(root, '/tmp/proj', 'cc-3')).toBeNull()
    // The traversal target EXISTS: only the id alphabet guard keeps it out.
    mkdirSync(join(tmp, 'secrets'), { recursive: true })
    writeFileSync(join(tmp, 'secrets', 'private.jsonl'), '')
    expect(locateTranscript(root, '/tmp/proj', '../../secrets/private')).toBeNull()
    expect(
      locateTranscript(root, '/tmp/proj', '../../secrets/private', indexTranscripts(root))
    ).toBeNull()
  })

  it('the fallback is an index built once: a stem found under another project dir, nothing probed', () => {
    const root = join(tmp, 'projects')
    mkdirSync(join(root, '-elsewhere'), { recursive: true })
    writeFileSync(join(root, '-elsewhere', 'cc-2.jsonl'), '')
    writeFileSync(join(root, 'not-a-dir.txt'), '')
    const index = indexTranscripts(root)
    expect([...index.keys()]).toEqual(['-elsewhere'])
    expect(index.get('-elsewhere')).toEqual(new Set(['cc-2']))
    expect(locateTranscript(root, '/tmp/proj', 'cc-2', new Map())).toBeNull()
    expect(locateTranscript(root, '/tmp/proj', 'cc-2', index)).toBe(
      join(root, '-elsewhere', 'cc-2.jsonl')
    )
    expect(indexTranscripts(join(tmp, 'nope')).size).toBe(0)
  })

  it('PeekCache reads a file once while unchanged, again when it moved, never caches a missing one', () => {
    const file = join(tmp, 'c.jsonl')
    writeFileSync(file, TAIL + '\n')
    let reads = 0
    const cache = new PeekCache((p) => {
      reads++
      return peekTranscript(p)
    })
    const first = cache.get(file)
    const second = cache.get(file)
    expect(reads).toBe(1)
    expect(second).toBe(first)
    writeFileSync(file, TAIL + '\n' + JSON.stringify({ type: 'ai-title', aiTitle: 'moved' }) + '\n')
    expect(cache.get(file).title).toBe('moved')
    expect(reads).toBe(2)
    expect(cache.get(join(tmp, 'gone.jsonl')).exists).toBe(false)
    expect(cache.get(null).exists).toBe(false)
    expect(cache.size()).toBe(1)
  })
})
