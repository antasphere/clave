/**
 * The servers' Histories in this Mac's (PRDCT-4321): each server's answer
 * read at once, its last answer kept for when it is offline, a server's
 * conversation as a History row keyed to that server, one row per
 * conversation when this Mac and its servers name the same one, and the
 * cache of the last answers on this Mac's disk.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resourceKey, sessionKey } from '@clave/contract/fleet'
import type { HistoryConversation } from '@clave/contract/history'
import type { HistoryListEntry } from './service'
import {
  chunk,
  fileServerHistoryCache,
  mergeServerHistories,
  readServerHistories,
  serverEntry,
  splitSearchIds,
  type ServerAnswer,
  type ServerHistoryCache,
  type ServerHistorySource
} from './fleet-history'

const conv = (
  over: Partial<HistoryConversation> & { conversationId: string }
): HistoryConversation => ({
  sessionId: 'tab-1',
  name: 'Odoo',
  title: 'Odoo research',
  cwd: '/srv/odoo',
  model: 'opus',
  groupId: null,
  groupName: null,
  workspaceId: null,
  firstSeenAt: '2026-11-01T10:00:00.000Z',
  lastHumanAt: '2026-11-09T10:00:00.000Z',
  lastPrompt: null,
  transcript: 'present',
  held: 'closed',
  ...over
})

/** One of this Mac's own History rows. */
const local = (
  over: Partial<HistoryListEntry> & { claudeSessionId: string }
): HistoryListEntry => ({
  source: 'ledger',
  provider: 'claude',
  sessionId: 'mac-tab',
  name: 'Mac tab',
  cwd: '/Users/me/odoo',
  mode: 'claude',
  model: null,
  workspaceId: null,
  groups: [],
  firstSeenAt: '2026-11-01T09:00:00.000Z',
  lastSeenAt: '2026-11-08T09:00:00.000Z',
  closedAt: null,
  transcript: {
    exists: true,
    path: '/Users/me/.claude/projects/x.jsonl',
    cwd: '/Users/me/odoo',
    firstAt: null,
    title: null,
    lastPrompt: null,
    lastHumanAt: null,
    modifiedAt: null,
    sizeBytes: 10
  },
  title: 'Mac row',
  lastHumanAt: '2026-11-08T09:00:00.000Z',
  ...over
})

const answer = (
  server: { id: string; name: string },
  online: boolean,
  conversations: HistoryConversation[]
): ServerAnswer => ({ server, online, conversations })

describe('readServerHistories: every connected server at once', () => {
  it('takes an answer, keeps it, and falls back to the last one for a server that fails or hangs', async () => {
    const fresh = [conv({ conversationId: 'a-1' })]
    const kept = {
      b: [conv({ conversationId: 'b-old' })],
      c: [conv({ conversationId: 'c-old' })]
    }
    const list = vi.fn((serverId: string): Promise<readonly HistoryConversation[]> => {
      if (serverId === 'a') return Promise.resolve(fresh)
      if (serverId === 'b') return Promise.reject(new Error('connection refused'))
      return new Promise(() => {})
    })
    const source: ServerHistorySource = {
      servers: () => [
        { id: 'local', name: 'This Mac' },
        { id: 'a', name: 'Studio' },
        { id: 'b', name: 'Lab' },
        { id: 'c', name: 'Attic' }
      ],
      list,
      search: async () => ({ hits: [], filesSearched: 0, truncated: false })
    }
    const cache: ServerHistoryCache = {
      read: vi.fn((serverId: string) => kept[serverId as 'b' | 'c'] ?? null),
      write: vi.fn()
    }
    const answers = await readServerHistories(source, cache, 20)
    expect(answers).toEqual([
      { server: { id: 'a', name: 'Studio' }, online: true, conversations: fresh },
      { server: { id: 'b', name: 'Lab' }, online: false, conversations: kept.b },
      { server: { id: 'c', name: 'Attic' }, online: false, conversations: kept.c }
    ])
    expect(cache.write).toHaveBeenCalledTimes(1)
    expect(cache.write).toHaveBeenCalledWith('a', fresh)
    expect(list).not.toHaveBeenCalledWith('local')
  })

  it('takes a server older than its History as online with nothing to list, its last answer left as it was', async () => {
    // The client's HistoryMissing, told by its name.
    const missing = Object.assign(new Error('no History route'), { name: 'HistoryMissing' })
    const source: ServerHistorySource = {
      servers: () => [{ id: 'old', name: 'Old VPS' }],
      list: () => Promise.reject(missing),
      search: async () => ({ hits: [], filesSearched: 0, truncated: false })
    }
    const cache: ServerHistoryCache = {
      read: vi.fn(() => [conv({ conversationId: 'kept' })]),
      write: vi.fn()
    }
    expect(await readServerHistories(source, cache, 20)).toEqual([
      { server: { id: 'old', name: 'Old VPS' }, online: true, conversations: [] }
    ])
    expect(cache.write).not.toHaveBeenCalled()
    expect(cache.read).not.toHaveBeenCalled()
  })

  it('answers nothing when the servers cannot be read', async () => {
    const source: ServerHistorySource = {
      servers: () => {
        throw new Error('no fleet')
      },
      list: vi.fn(),
      search: vi.fn()
    }
    const cache: ServerHistoryCache = { read: vi.fn(), write: vi.fn() }
    expect(await readServerHistories(source, cache, 20)).toEqual([])
    expect(source.list).not.toHaveBeenCalled()
  })
})

describe('chunk: what one search request carries', () => {
  it('cuts the items in runs of at most the size, in order', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `c-${i}`)
    const parts = chunk(ids, 100)
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50])
    expect(parts.flat()).toEqual(ids)
    expect(chunk(['a', 'b'], 100)).toEqual([['a', 'b']])
    expect(chunk([], 100)).toEqual([])
    expect(chunk(['a', 'b', 'c'], 0)).toEqual([['a'], ['b'], ['c']])
  })
})

describe('splitSearchIds: who searches which conversation', () => {
  it('sends each server its own conversations and keeps the rest on this Mac, once each', () => {
    const owners: Record<string, string> = { s1: 'srv-a', s2: 'srv-b', s3: 'srv-a' }
    const { local, byServer } = splitSearchIds(
      ['m1', 's1', 's2', 'm2', 's3', 's1', 'm1'],
      (id) => owners[id]
    )
    expect(local).toEqual(['m1', 'm2'])
    expect([...byServer]).toEqual([
      ['srv-a', ['s1', 's3']],
      ['srv-b', ['s2']]
    ])
  })

  it('keeps everything on this Mac when no server answered for it', () => {
    const { local, byServer } = splitSearchIds(['m1', 'm2'], () => undefined)
    expect(local).toEqual(['m1', 'm2'])
    expect(byServer.size).toBe(0)
  })
})

describe('serverEntry: a server’s conversation as a History row', () => {
  const server = { id: 'srv', name: 'Studio' }

  it('is the server’s, keyed to its tab, its workspace and its group', () => {
    const entry = serverEntry(
      server,
      true,
      conv({
        conversationId: 'c1',
        sessionId: 'tab-7',
        workspaceId: 'ws-9',
        groupId: 'g1',
        groupName: 'Group',
        held: 'running'
      })
    )
    expect(entry).toMatchObject({
      source: 'server',
      provider: 'claude',
      claudeSessionId: 'c1',
      server: { id: 'srv', name: 'Studio', online: true, held: 'running' },
      sessionId: sessionKey({ serverId: 'srv', sessionId: 'tab-7' }),
      workspaceId: resourceKey('workspace', 'srv', 'ws-9'),
      groups: [
        {
          id: resourceKey('group', 'srv', 'g1'),
          name: 'Group',
          firstAt: '2026-11-01T10:00:00.000Z'
        }
      ],
      title: 'Odoo research',
      lastSeenAt: '2026-11-09T10:00:00.000Z',
      lastHumanAt: '2026-11-09T10:00:00.000Z',
      closedAt: null
    })
    expect(entry.transcript.exists).toBe(true)
  })

  it('names no workspace nor group the server did not, says a gone transcript, and falls back to the name', () => {
    const entry = serverEntry(
      server,
      false,
      conv({ conversationId: 'c2', title: null, name: 'Tab name', transcript: 'gone' })
    )
    expect(entry.workspaceId).toBeNull()
    expect(entry.groups).toEqual([])
    expect(entry.transcript.exists).toBe(false)
    expect(entry.title).toBe('Tab name')
    expect(entry.server).toEqual({ id: 'srv', name: 'Studio', online: false, held: 'closed' })
    // A closed conversation's close is its last human time.
    expect(entry.closedAt).toBe('2026-11-09T10:00:00.000Z')
  })
})

describe('mergeServerHistories: one row per conversation', () => {
  const srv = { id: 'srv', name: 'Studio' }

  it('replaces a bare transcript this Mac sees with the server’s row', () => {
    const merged = mergeServerHistories(
      [local({ claudeSessionId: 'c1', source: 'transcript' })],
      [answer(srv, true, [conv({ conversationId: 'c1' })])]
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ source: 'server', server: { id: 'srv' } })
  })

  it('replaces this Mac’s own record of the server’s tab with the server’s row', () => {
    const merged = mergeServerHistories(
      [
        local({
          claudeSessionId: 'c1',
          sessionId: sessionKey({ serverId: 'srv', sessionId: 'tab' }),
          // Seen after the server's sighting: still the server's.
          lastSeenAt: '2026-11-10T09:00:00.000Z'
        })
      ],
      [answer(srv, true, [conv({ conversationId: 'c1' })])]
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].source).toBe('server')
  })

  it('keeps a conversation a tab of this Mac saw later than the server, else takes the server’s', () => {
    const later = mergeServerHistories(
      [local({ claudeSessionId: 'c1', lastSeenAt: '2026-11-10T09:00:00.000Z' })],
      [answer(srv, true, [conv({ conversationId: 'c1' })])]
    )
    expect(later).toHaveLength(1)
    expect(later[0]).toMatchObject({ source: 'ledger', sessionId: 'mac-tab' })
    expect(later[0].server).toBeUndefined()
    const earlier = mergeServerHistories(
      [local({ claudeSessionId: 'c1', lastSeenAt: '2026-11-08T09:00:00.000Z' })],
      [answer(srv, true, [conv({ conversationId: 'c1' })])]
    )
    expect(earlier).toHaveLength(1)
    expect(earlier[0].source).toBe('server')
  })

  it('tags a record of a server’s tab its answer does not name with that server', () => {
    const owned = local({
      claudeSessionId: 'c-unnamed',
      sessionId: sessionKey({ serverId: 'srv', sessionId: 'tab' })
    })
    const orphan = local({
      claudeSessionId: 'c-orphan',
      sessionId: sessionKey({ serverId: 'gone-server', sessionId: 'tab' })
    })
    const merged = mergeServerHistories(
      [owned, orphan],
      [answer(srv, false, [conv({ conversationId: 'c-other' })])]
    )
    const byId = new Map(merged.map((e) => [e.claudeSessionId, e]))
    expect(byId.get('c-unnamed')).toMatchObject({
      source: 'ledger',
      server: { id: 'srv', name: 'Studio', online: false, held: null }
    })
    expect(byId.get('c-orphan')?.server).toEqual({
      id: 'gone-server',
      name: 'Server',
      online: false,
      held: null
    })
    expect(byId.get('c-other')?.source).toBe('server')
    expect(merged).toHaveLength(3)
  })

  it('tags an owned record with its server’s online state when the server answered', () => {
    const merged = mergeServerHistories(
      [
        local({
          claudeSessionId: 'c-unnamed',
          sessionId: sessionKey({ serverId: 'srv', sessionId: 'tab' })
        })
      ],
      [answer(srv, true, [])]
    )
    expect(merged[0].server).toEqual({ id: 'srv', name: 'Studio', online: true, held: null })
  })

  it('keeps one row of a conversation two servers name: the later', () => {
    const merged = mergeServerHistories(
      [],
      [
        answer(srv, true, [
          conv({ conversationId: 'c1', lastHumanAt: '2026-11-09T10:00:00.000Z' })
        ]),
        answer({ id: 'srv-2', name: 'Lab' }, true, [
          conv({ conversationId: 'c1', lastHumanAt: '2026-11-09T11:00:00.000Z' })
        ]),
        answer({ id: 'srv-3', name: 'Attic' }, true, [
          conv({ conversationId: 'c1', lastHumanAt: '2026-11-09T09:00:00.000Z' })
        ])
      ]
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].server?.id).toBe('srv-2')
  })

  it('leaves this Mac’s own rows untouched', () => {
    const mine = [
      local({ claudeSessionId: 'm1' }),
      local({ claudeSessionId: 'm2', source: 'transcript', sessionId: '' })
    ]
    const merged = mergeServerHistories(mine, [answer(srv, true, [conv({ conversationId: 'c1' })])])
    expect(merged.slice(0, 2)).toEqual(mine)
    expect(merged[0]).toBe(mine[0])
    expect(merged[1]).toBe(mine[1])
    expect(merged[2].claudeSessionId).toBe('c1')
  })

  it('skips one malformed conversation alone, never the rest of the servers', () => {
    const srv = { id: 'srv', name: 'Studio' }
    const other = { id: 'srv-2', name: 'Box' }
    const merged = mergeServerHistories(
      [],
      [
        answer(srv, true, [
          conv({ conversationId: 'bad', sessionId: '' }),
          conv({ conversationId: 'ok' })
        ]),
        answer(other, true, [conv({ conversationId: 'other' })])
      ]
    )
    expect(merged.map((e) => e.claudeSessionId).sort()).toEqual(['ok', 'other'])
  })
})

describe('fileServerHistoryCache: each server’s last answer on this Mac', () => {
  let tmp: string
  let dir: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'clave-fleet-history-test-'))
    dir = join(tmp, 'cache')
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('reads back what it wrote', () => {
    const cache = fileServerHistoryCache(dir)
    const conversations = [conv({ conversationId: 'c1' }), conv({ conversationId: 'c2' })]
    cache.write('srv', conversations)
    expect(cache.read('srv')).toEqual(conversations)
  })

  it('reads nothing for a server never written, a corrupt file or a file of another shape', () => {
    const cache = fileServerHistoryCache(dir)
    expect(cache.read('never')).toBeNull()
    cache.write('srv', [])
    writeFileSync(join(dir, 'corrupt.json'), '{not json')
    expect(cache.read('corrupt')).toBeNull()
    writeFileSync(join(dir, 'odd.json'), JSON.stringify({ v: 1, conversations: 'nope' }))
    expect(cache.read('odd')).toBeNull()
  })

  it('keeps a server id with a slash or a colon inside its directory', () => {
    const cache = fileServerHistoryCache(dir)
    const conversations = [conv({ conversationId: 'c1' })]
    cache.write('team/box:7', conversations)
    cache.write('../escape', conversations)
    expect(readdirSync(tmp)).toEqual(['cache'])
    expect(readdirSync(dir).sort()).toEqual(
      [`${encodeURIComponent('team/box:7')}.json`, `${encodeURIComponent('../escape')}.json`].sort()
    )
    expect(cache.read('team/box:7')).toEqual(conversations)
    expect(cache.read('../escape')).toEqual(conversations)
  })
})
