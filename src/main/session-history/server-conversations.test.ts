/**
 * A server's own History (PRDCT-4321): the ledger it keeps of what its tabs
 * ran, stamped only when what the History shows of a tab changed (a restart
 * included), a deleted tab's conversation kept listed and found on the disk
 * (its account directory included), Claude conversations only, the server's
 * own groups and workspaces, the title helper's one-shots left out, a search
 * over the listed transcripts only, and a ledger that cannot be written told
 * and never thrown.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '@clave/contract/sessions'
import {
  runningIn,
  serverConversations,
  type ServerConversationsOptions
} from './server-conversations'
import { TITLE_HELPER_MARKER } from './index'
import { transcriptPath } from './transcript-peek'

const CWD = '/work/odoo'
const NOW = new Date('2026-11-10T12:00:00.000Z')

let tmp: string
let dataDir: string
let root: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clave-server-history-test-'))
  dataDir = join(tmp, 'data')
  root = join(tmp, 'projects')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(root, { recursive: true })
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function claudeRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'tab-1',
    cwd: CWD,
    folderName: 'odoo',
    displayName: 'Odoo research',
    claudeMode: true,
    antigravityMode: false,
    codexMode: false,
    piMode: false,
    claudeAgentsMode: false,
    dangerousMode: false,
    claudeSessionId: 'conv-1',
    ...over
  }
}

/** A Claude Code transcript under `projectsRoot`, as Claude Code lays it out. */
function writeTranscript(
  projectsRoot: string,
  id: string,
  opts: { cwd?: string; said?: string; title?: string; lastPrompt?: string } = {}
): string {
  const cwd = opts.cwd ?? CWD
  const said = opts.said ?? 'hello'
  const file = transcriptPath(projectsRoot, cwd, id)
  mkdirSync(dirname(file), { recursive: true })
  const lines: unknown[] = [
    {
      type: 'user',
      message: { role: 'user', content: said },
      timestamp: '2026-11-10T10:00:00.000Z',
      cwd
    },
    { type: 'ai-title', aiTitle: opts.title ?? 'My title' },
    { type: 'last-prompt', lastPrompt: opts.lastPrompt ?? said }
  ]
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return file
}

function ledgerLines(dir = dataDir): string[] {
  const file = join(dir, 'history', 'ledger.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
}

function harness(
  options: Partial<Omit<ServerConversationsOptions, 'records'>> & { records?: SessionRecord[] } = {}
): {
  conversations: ReturnType<typeof serverConversations>
  records: SessionRecord[]
  runningIds: Set<string>
  log: ReturnType<typeof vi.fn>
} {
  const { records = [], ...over } = options
  const runningIds = new Set<string>()
  const log = vi.fn()
  const conversations = serverConversations({
    dataDir,
    records: () => records,
    running: (id) => runningIds.has(id),
    transcriptsRoot: () => root,
    now: () => NOW,
    log,
    ...over
  })
  return { conversations, records, runningIds, log }
}

describe('serverConversations: the ledger of what the tabs ran', () => {
  it('stamps a tab once, nothing when nothing changed, and again on a rename', () => {
    const h = harness()
    h.records.push(claudeRecord())
    h.conversations.observe('tab-1')
    const lines = ledgerLines()
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      kind: 'placed',
      sessionId: 'tab-1',
      claudeSessionId: 'conv-1',
      name: 'Odoo research',
      cwd: CWD,
      mode: 'claude'
    })
    h.conversations.observe('tab-1')
    expect(ledgerLines()).toHaveLength(1)
    h.records[0] = { ...h.records[0], displayName: 'Odoo invoices' }
    h.conversations.observe('tab-1')
    const after = ledgerLines()
    expect(after).toHaveLength(2)
    expect(JSON.parse(after[1])).toMatchObject({ kind: 'placed', name: 'Odoo invoices' })
  })

  it('stamps nothing after a restart for a tab that did not change (identity seeded from the ledger)', () => {
    const records = [claudeRecord()]
    harness({ records }).conversations.observe('tab-1')
    expect(ledgerLines()).toHaveLength(1)
    const restarted = harness({ records })
    restarted.conversations.observe('tab-1')
    restarted.conversations.list()
    expect(ledgerLines()).toHaveLength(1)
  })

  it('keeps a deleted tab listed, closed, with its transcript, title, last prompt and old tab id', () => {
    writeTranscript(root, 'conv-1', { said: 'hello', title: 'My title' })
    const h = harness()
    const tab = claudeRecord()
    h.records.push(tab)
    h.conversations.observe('tab-1')
    h.conversations.closing(tab)
    h.records.splice(0)
    expect(JSON.parse(ledgerLines().at(-1)!)).toMatchObject({ kind: 'closed', sessionId: 'tab-1' })
    const { conversations } = h.conversations.list()
    expect(conversations).toHaveLength(1)
    expect(conversations[0]).toMatchObject({
      conversationId: 'conv-1',
      sessionId: 'tab-1',
      name: 'Odoo research',
      cwd: CWD,
      held: 'closed',
      transcript: 'present',
      title: 'My title',
      lastPrompt: 'hello',
      lastHumanAt: '2026-11-10T10:00:00.000Z'
    })
  })

  it('keeps the launch profile a deleted tab ran on, so it reopens the same way', () => {
    writeTranscript(root, 'conv-1')
    const h = harness()
    const tab = claudeRecord({ launchProfileId: 'chat:claude:mine' })
    h.records.push(tab)
    h.conversations.observe('tab-1')
    h.conversations.closing(tab)
    h.records.splice(0)
    expect(h.conversations.list().conversations[0].launchProfileId).toBe('chat:claude:mine')
  })

  it('says a held conversation running or stopped from the record and the running set', () => {
    writeTranscript(root, 'conv-1')
    const h = harness()
    h.records.push(claudeRecord())
    h.runningIds.add('tab-1')
    expect(h.conversations.list().conversations[0].held).toBe('running')
    h.runningIds.delete('tab-1')
    expect(h.conversations.list().conversations[0].held).toBe('stopped')
  })

  it('lists a conversation whose transcript is not on the disk as gone', () => {
    const h = harness()
    h.records.push(claudeRecord())
    const [conversation] = h.conversations.list().conversations
    expect(conversation).toMatchObject({
      conversationId: 'conv-1',
      transcript: 'gone',
      title: null,
      lastPrompt: null,
      // No human message to read: the last sighting.
      lastHumanAt: NOW.toISOString()
    })
  })

  it.each<[string, Partial<SessionRecord>]>([
    ['a Codex record', { codexMode: true }],
    ['a Claude agents record', { claudeAgentsMode: true }],
    ['a routine run', { link: { kind: 'routine', routineKey: 'nightly', runId: 'run-1' } }],
    ['a group terminal', { link: { kind: 'group-terminal', groupId: 'g1', terminalId: 't1' } }],
    ['a record with no Claude session id', { claudeSessionId: undefined }],
    ['a record with an empty Claude session id', { claudeSessionId: '' }]
  ])('never lists nor stamps %s', (_case, over) => {
    writeTranscript(root, 'conv-1')
    const h = harness()
    const tab = claudeRecord(over)
    h.records.push(tab)
    h.conversations.observe('tab-1')
    h.conversations.closing(tab)
    expect(h.conversations.list().conversations).toEqual([])
    expect(ledgerLines()).toEqual([])
  })

  it('finds a deleted tab’s transcript under its own account directory', () => {
    const account = join(tmp, 'account-home')
    writeTranscript(join(account, 'projects'), 'conv-acct', { title: 'Account title' })
    const h = harness()
    const tab = claudeRecord({ claudeSessionId: 'conv-acct', configDir: account })
    h.records.push(tab)
    h.conversations.observe('tab-1')
    h.conversations.closing(tab)
    h.records.splice(0)
    expect(JSON.parse(ledgerLines()[0])).toMatchObject({ configDir: account })
    const [conversation] = h.conversations.list().conversations
    expect(conversation).toMatchObject({
      conversationId: 'conv-acct',
      held: 'closed',
      transcript: 'present',
      title: 'Account title'
    })
  })

  it('lists both conversations of a tab that ran /clear', () => {
    writeTranscript(root, 'conv-1')
    writeTranscript(root, 'conv-2', { title: 'After clear' })
    const h = harness()
    h.records.push(claudeRecord())
    h.conversations.observe('tab-1')
    h.records[0] = { ...h.records[0], claudeSessionId: 'conv-2' }
    h.conversations.observe('tab-1')
    expect(ledgerLines()).toHaveLength(2)
    const byId = new Map(h.conversations.list().conversations.map((c) => [c.conversationId, c]))
    expect([...byId.keys()].sort()).toEqual(['conv-1', 'conv-2'])
    expect(byId.get('conv-1')).toMatchObject({ sessionId: 'tab-1', held: 'closed' })
    expect(byId.get('conv-2')).toMatchObject({
      sessionId: 'tab-1',
      held: 'stopped',
      title: 'After clear'
    })
  })

  it('lists the server group and its workspace for a record with no workspace of its own', () => {
    writeTranscript(root, 'conv-1')
    const groupOf = vi.fn(() => ({ id: 'g1', name: 'Group', workspaceId: 'ws-1' }))
    const h = harness({ groupOf })
    h.records.push(claudeRecord())
    const [conversation] = h.conversations.list().conversations
    expect(groupOf).toHaveBeenCalledWith('tab-1')
    expect(conversation).toMatchObject({ groupId: 'g1', groupName: 'Group', workspaceId: 'ws-1' })
  })

  it('never lists one of the title helper’s one-shots', () => {
    writeTranscript(root, 'conv-1')
    writeTranscript(root, 'conv-helper', {
      lastPrompt: `${TITLE_HELPER_MARKER}. The conversation so far: ...`
    })
    const h = harness()
    h.records.push(claudeRecord(), claudeRecord({ id: 'tab-2', claudeSessionId: 'conv-helper' }))
    expect(h.conversations.list().conversations.map((c) => c.conversationId)).toEqual(['conv-1'])
  })

  it('searches the listed conversations’ transcripts, never one no record or row names', async () => {
    writeTranscript(root, 'conv-1', { said: 'Migrate the invoices to Odoo' })
    // Same disk, same phrase, but no tab of this server ever ran it.
    writeTranscript(root, 'conv-stranger', { said: 'Migrate the invoices to Odoo' })
    const h = harness()
    h.records.push(claudeRecord())
    const result = await h.conversations.search({ query: 'invoices', scopes: ['human'] })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.every((hit) => hit.conversationId === 'conv-1')).toBe(true)
    expect(result.hits[0]).toMatchObject({ conversationId: 'conv-1', scope: 'human' })
    expect(result.hits[0].excerpt).toContain('invoices')
    expect(result.filesSearched).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it('searches only the conversations asked for, before the cap', async () => {
    // Three listed conversations hold the phrase; the client asks about the
    // oldest one only, and only that one is read.
    writeTranscript(root, 'conv-old', { said: 'the marigold lantern' })
    writeTranscript(root, 'conv-mid', { said: 'the marigold lantern' })
    writeTranscript(root, 'conv-new', { said: 'the marigold lantern' })
    let clock = Date.parse('2026-11-10T08:00:00.000Z')
    const h = harness({ now: () => new Date((clock += 60_000)) })
    h.records.push(
      claudeRecord({ id: 'tab-old', claudeSessionId: 'conv-old' }),
      claudeRecord({ id: 'tab-mid', claudeSessionId: 'conv-mid' }),
      claudeRecord({ id: 'tab-new', claudeSessionId: 'conv-new' })
    )
    const everything = await h.conversations.search({ query: 'marigold', scopes: ['human'] })
    expect(new Set(everything.hits.map((hit) => hit.conversationId))).toEqual(
      new Set(['conv-old', 'conv-mid', 'conv-new'])
    )
    const asked = await h.conversations.search({
      query: 'marigold',
      scopes: ['human'],
      ids: ['conv-old']
    })
    expect(asked.hits.length).toBeGreaterThan(0)
    expect(asked.hits.every((hit) => hit.conversationId === 'conv-old')).toBe(true)
    expect(asked.filesSearched).toBe(1)
  })

  it('lists a tab in the group it is in now, not the last one it first entered', () => {
    writeTranscript(root, 'conv-1')
    let clock = Date.parse('2026-11-10T08:00:00.000Z')
    let group: { id: string; name: string } | null = { id: 'g-A', name: 'Alpha' }
    const h = harness({ now: () => new Date((clock += 1_000)), groupOf: () => group })
    const tab = claudeRecord()
    h.records.push(tab)
    h.conversations.observe('tab-1')
    group = { id: 'g-B', name: 'Beta' }
    h.conversations.observe('tab-1')
    group = { id: 'g-A', name: 'Alpha' }
    h.conversations.observe('tab-1')
    h.conversations.closing(tab)
    h.records.splice(0)
    expect(ledgerLines().map((l) => JSON.parse(l).groupId)).toEqual(['g-A', 'g-B', 'g-A', 'g-A'])
    expect(h.conversations.list().conversations[0]).toMatchObject({
      groupId: 'g-A',
      groupName: 'Alpha'
    })
  })

  it('lists a tab moved out of every group with no group', () => {
    writeTranscript(root, 'conv-1')
    let clock = Date.parse('2026-11-10T08:00:00.000Z')
    let group: { id: string; name: string } | null = { id: 'g-A', name: 'Alpha' }
    const h = harness({ now: () => new Date((clock += 1_000)), groupOf: () => group })
    h.records.push(claudeRecord())
    h.conversations.observe('tab-1')
    group = null
    h.conversations.observe('tab-1')
    expect(h.conversations.list().conversations[0]).toMatchObject({
      groupId: null,
      groupName: null
    })
  })

  it('tells a ledger that cannot be written through log, and never throws', () => {
    const notADirectory = join(tmp, 'a-file')
    writeFileSync(notADirectory, 'not a directory')
    const h = harness({ dataDir: notADirectory })
    const tab = claudeRecord()
    h.records.push(tab)
    expect(() => h.conversations.observe('tab-1')).not.toThrow()
    expect(h.log).toHaveBeenCalledWith(
      '[server-history] failed to append to the ledger',
      expect.any(Error)
    )
    expect(() => h.conversations.closing(tab)).not.toThrow()
    expect(() => h.conversations.list()).not.toThrow()
  })
})

describe('runningIn: the daemon’s rule for a tab that runs its conversation', () => {
  it('is a session the host holds whose state is not ended', () => {
    const sessions = new Map<string, { state?: string }>([
      ['working', { state: 'working' }],
      ['idle', { state: 'idle' }],
      ['ended', { state: 'ended' }]
    ])
    const running = runningIn({ get: (id) => sessions.get(id) })
    expect(running('working')).toBe(true)
    expect(running('idle')).toBe(true)
    // A chat whose CLI ended on its own is held, not running: its Resume restarts it.
    expect(running('ended')).toBe(false)
    expect(running('not-held')).toBe(false)
  })
})
