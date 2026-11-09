import { describe, expect, it } from 'vitest'
import type { Session, SessionRecord } from '@clave/contract/sessions'
import type { HistoryListEntry } from '../session-history/service'
import {
  holdersOf,
  listConversations,
  openResumed,
  RECORDS_BY_ID_CHUNK,
  recordsWithStopped,
  planResume,
  planResumeFromRecords,
  ResumeRefused,
  type HistoryLookups,
  type ResumeOpenIo
} from './conversation-history'

/**
 * The agent tools' view of past conversations (PRDCT-4236): the History rows
 * with their filters and their open tab, and the plan a `resume` takes, each
 * refusal in words. On fakes: the dialog's rules, not the dialog.
 */
const entry = (over: Partial<HistoryListEntry> & { claudeSessionId: string }): HistoryListEntry =>
  ({
    source: 'ledger',
    provider: 'claude',
    sessionId: '',
    name: '',
    cwd: '/work/odoo',
    mode: 'claude',
    model: 'claude-opus-5-5',
    workspaceId: 'ws1',
    groups: [{ id: 'g1', name: 'Finance', firstAt: '2026-11-01T10:00:00Z' }],
    firstSeenAt: '2026-11-01T10:00:00Z',
    lastSeenAt: '2026-11-09T08:00:00Z',
    closedAt: null,
    transcript: {
      exists: true,
      path: '/t/x.jsonl',
      cwd: '/work/odoo',
      firstAt: null,
      title: null,
      lastPrompt: null,
      lastHumanAt: null,
      modifiedAt: null,
      sizeBytes: 10
    },
    title: 'Odoo accounting research',
    lastHumanAt: '2026-11-09T08:00:00Z',
    ...over
  }) as HistoryListEntry

const record = (id: string, over: Partial<SessionRecord> = {}): SessionRecord =>
  ({
    id,
    cwd: '/work/odoo',
    folderName: 'odoo',
    claudeMode: true,
    antigravityMode: false,
    codexMode: false,
    piMode: false,
    claudeAgentsMode: false,
    dangerousMode: false,
    ...over
  }) as SessionRecord

const session = (id: string, state: Session['state']): Session =>
  ({
    id,
    provider: 'claude',
    transport: 'events',
    cwd: '/work/odoo',
    windowKey: 'w',
    state,
    createdAt: 1,
    adapterId: 'claude-chat',
    title: id
  }) as Session

const lookups = (
  history: HistoryListEntry[],
  records: SessionRecord[] = [],
  sessions: Session[] = []
): HistoryLookups => ({
  history: () => history,
  records: async () => records,
  sessions: async () => sessions,
  workspaces: () => [
    { id: 'ws1', name: 'Antasphere' },
    { id: 'ws2', name: 'Clave' }
  ]
})

describe('holdersOf: the tab that holds a conversation', () => {
  it('names a live holder alive and a stopped record stopped, by any provider id', () => {
    const holders = holdersOf(
      [
        record('a', { claudeSessionId: 'c1', running: true }),
        record('b', { codexThreadId: 't1', running: false }),
        record('c', { piSessionId: 'p1', running: true })
      ],
      [session('a', 'idle'), session('c', 'ended')]
    )
    expect(holders.get('c1')).toEqual({ sessionId: 'a', alive: true })
    expect(holders.get('t1')).toEqual({ sessionId: 'b', alive: false })
    // Held by the host but its process exited: stopped, Resume is the way back.
    expect(holders.get('p1')).toEqual({ sessionId: 'c', alive: false })
  })

  it('prefers the alive holder when two tabs carry one conversation', () => {
    const holders = holdersOf(
      [
        record('old', { claudeSessionId: 'c1', running: false }),
        record('new', { claudeSessionId: 'c1', running: true })
      ],
      [session('new', 'working')]
    )
    expect(holders.get('c1')).toEqual({ sessionId: 'new', alive: true })
  })
})

describe('listConversations: the History rows for an agent', () => {
  const history = [
    entry({ claudeSessionId: 'c1' }),
    entry({
      claudeSessionId: 'c2',
      title: 'Clave token sharing',
      workspaceId: 'ws2',
      cwd: '/work/clave',
      lastHumanAt: '2026-11-09T09:00:00Z'
    }),
    entry({
      claudeSessionId: 'x1',
      provider: 'codex',
      title: 'A codex thread',
      source: 'transcript',
      workspaceId: null,
      lastHumanAt: '2026-11-08T09:00:00Z'
    }),
    entry({
      claudeSessionId: 'gone',
      title: 'Lost transcript',
      transcript: { ...entry({ claudeSessionId: 'gone' }).transcript, exists: false },
      lastHumanAt: '2026-11-07T09:00:00Z'
    })
  ]

  it('answers every row newest first, with the workspace name, the groups and the open tab', async () => {
    const { rows, total } = await listConversations(
      lookups(
        history,
        [record('tab', { claudeSessionId: 'c1', running: true })],
        [session('tab', 'idle')]
      )
    )
    expect(total).toBe(4)
    expect(rows.map((r) => r.conversationId)).toEqual(['c2', 'c1', 'x1', 'gone'])
    const c1 = rows.find((r) => r.conversationId === 'c1')!
    expect(c1).toMatchObject({
      provider: 'claude',
      title: 'Odoo accounting research',
      cwd: '/work/odoo',
      model: 'claude-opus-5-5',
      workspaceId: 'ws1',
      workspaceName: 'Antasphere',
      groups: ['Finance'],
      lastActivity: '2026-11-09T08:00:00Z',
      transcriptExists: true,
      resumable: true,
      open: { sessionId: 'tab', alive: true }
    })
    expect(rows.find((r) => r.conversationId === 'c2')!.open).toBeNull()
    expect(rows.find((r) => r.conversationId === 'gone')!.resumable).toBe(false)
    expect(rows.find((r) => r.conversationId === 'x1')!.workspaceName).toBeNull()
  })

  it('filters by query on the title, the name and the directory, case-insensitively', async () => {
    const h = lookups(history)
    expect(
      (await listConversations(h, { query: 'TOKEN' })).rows.map((r) => r.conversationId)
    ).toEqual(['c2'])
    expect(
      (await listConversations(h, { query: '/work/odoo' })).rows.map((r) => r.conversationId)
    ).toEqual(['c1', 'x1', 'gone'])
  })

  it('filters by workspace id or name, by provider, by open tab, and bounds the limit', async () => {
    const h = lookups(history, [record('tab', { claudeSessionId: 'gone', running: false })], [])
    expect(
      (await listConversations(h, { workspace: 'clave' })).rows.map((r) => r.conversationId)
    ).toEqual(['c2'])
    expect(
      (await listConversations(h, { workspace: 'ws1' })).rows.map((r) => r.conversationId)
    ).toEqual(['c1', 'gone'])
    expect(
      (await listConversations(h, { provider: 'codex' })).rows.map((r) => r.conversationId)
    ).toEqual(['x1'])
    const open = await listConversations(h, { open: true })
    expect(open.rows.map((r) => r.conversationId)).toEqual(['gone'])
    expect(open.rows[0].open).toEqual({ sessionId: 'tab', alive: false })
    const limited = await listConversations(h, { limit: 2 })
    expect(limited.rows).toHaveLength(2)
    expect(limited.total).toBe(4)
    expect((await listConversations(h, { limit: 0 })).rows).toHaveLength(1)
  })
})

describe('planResume: what a resume does with a conversation', () => {
  const exists = (p: string): boolean => p === '/work/odoo'

  it('answers the live tab that runs it, never a second process', async () => {
    const plan = await planResume(
      lookups(
        [entry({ claudeSessionId: 'c1' })],
        [record('tab', { claudeSessionId: 'c1', running: true })],
        [session('tab', 'idle')]
      ),
      'c1',
      exists
    )
    expect(plan).toEqual({ kind: 'open', sessionId: 'tab' })
  })

  it('resumes a stopped tab that still holds it, in that tab', async () => {
    const plan = await planResume(
      lookups(
        [entry({ claudeSessionId: 'c1' })],
        [record('tab', { claudeSessionId: 'c1', running: false })]
      ),
      'c1',
      exists
    )
    expect(plan).toEqual({ kind: 'stopped', sessionId: 'tab' })
  })

  it('starts a new tab in the conversation’s own directory when nothing holds it', async () => {
    const plan = await planResume(lookups([entry({ claudeSessionId: 'c1' })]), ' c1 ', exists)
    expect(plan).toEqual({
      kind: 'start',
      cwd: '/work/odoo',
      provider: 'claude',
      title: 'Odoo accounting research',
      model: 'claude-opus-5-5',
      workspaceId: 'ws1',
      piProvider: null,
      piThinking: null
    })
  })

  it('opens in the directory the caller names, whatever the transcript says (round 1, F4)', async () => {
    const gone = lookups([entry({ claudeSessionId: 'c1', cwd: '/gone' })])
    await expect(planResume(gone, 'c1', exists)).rejects.toThrow('no longer exists')
    expect(await planResume(gone, 'c1', exists, '/work/odoo')).toMatchObject({
      kind: 'start',
      cwd: '/work/odoo'
    })
    const none = lookups([entry({ claudeSessionId: 'c1', cwd: '' })])
    expect(await planResume(none, 'c1', exists, '/elsewhere')).toMatchObject({ cwd: '/elsewhere' })
  })

  it('carries a Pi conversation’s provider and thinking level', async () => {
    const plan = await planResume(
      lookups([
        entry({ claudeSessionId: 'p1', provider: 'pi', agentProvider: 'openai', thinking: 'high' })
      ]),
      'p1',
      exists
    )
    expect(plan).toMatchObject({
      kind: 'start',
      provider: 'pi',
      piProvider: 'openai',
      piThinking: 'high'
    })
  })

  it('refuses in words: unknown, a provider that does not resume, a transcript gone, no directory, a directory gone', async () => {
    await expect(planResume(lookups([]), 'nope', exists)).rejects.toThrow(
      'No conversation "nope" in the History. clave_history lists the conversations and their ids.'
    )
    await expect(
      planResume(lookups([entry({ claudeSessionId: 'g', provider: 'antigravity' })]), 'g', exists)
    ).rejects.toThrow('cannot be resumed')
    await expect(
      planResume(
        lookups([
          entry({
            claudeSessionId: 'c1',
            transcript: { ...entry({ claudeSessionId: 'c1' }).transcript, exists: false }
          })
        ]),
        'c1',
        exists
      )
    ).rejects.toThrow('The transcript of conversation "c1" ("Odoo accounting research") is gone')
    await expect(
      planResume(lookups([entry({ claudeSessionId: 'c1', cwd: '' })]), 'c1', exists)
    ).rejects.toThrow('names no working directory')
    await expect(
      planResume(lookups([entry({ claudeSessionId: 'c1', cwd: '/gone' })]), 'c1', exists)
    ).rejects.toThrow('/gone, no longer exists')
    await expect(planResume(lookups([]), '  ', exists)).rejects.toBeInstanceOf(ResumeRefused)
  })
})

describe('planResumeFromRecords: a Clave server’s own records', () => {
  it('finds the live or stopped holder, else nothing', () => {
    const records = [
      record('live', { claudeSessionId: 'c1', running: true }),
      record('old', { codexThreadId: 't1', running: false })
    ]
    const sessions = [session('live', 'working')]
    expect(planResumeFromRecords(records, sessions, 'c1')).toEqual({
      kind: 'open',
      sessionId: 'live'
    })
    expect(planResumeFromRecords(records, sessions, 't1')).toEqual({
      kind: 'stopped',
      sessionId: 'old'
    })
    expect(planResumeFromRecords(records, sessions, 'none')).toBeNull()
  })
})

/**
 * The whole decision of `clave_open_session` with `resume` (round 1, E2: it
 * lived in the tool's host and nothing reached it), on a fake host.
 */
describe('openResumed: what the open does with a resume', () => {
  const io = (): ResumeOpenIo & { restarted: string[]; focused: string[] } => {
    const restarted: string[] = []
    const focused: string[] = []
    return {
      restarted,
      focused,
      isDirectory: (p) => p === '/work/odoo',
      isRegisteredWorkspace: (id) => id === 'ws1',
      restart: async (id) => {
        restarted.push(id)
        return { resumed: true }
      },
      focus: async (id) => {
        focused.push(id)
      }
    }
  }
  const history = [
    entry({ claudeSessionId: 'c1' }),
    entry({ claudeSessionId: 'x1', provider: 'codex', title: 'A codex thread', model: null }),
    entry({
      claudeSessionId: 'p1',
      provider: 'pi',
      title: 'A pi talk',
      agentProvider: 'openai',
      thinking: 'high'
    })
  ]

  it('a live holder is focused and answered, nothing restarted, no identity needed', async () => {
    const h = io()
    const out = await openResumed(
      lookups(
        history,
        [record('tab', { claudeSessionId: 'c1', running: true })],
        [session('tab', 'idle')]
      ),
      { resume: 'c1' },
      undefined,
      h
    )
    expect(out).toEqual({
      result: {
        sessionId: 'tab',
        groupId: null,
        conversation: 'c1',
        alreadyOpen: true,
        resumed: false,
        note: 'A tab already runs this conversation; it was focused and nothing was started.'
      }
    })
    expect(h.focused).toEqual(['tab'])
    expect(h.restarted).toEqual([])
  })

  it('a stopped holder is resumed in place and focused; without a tab identity it is refused (F5)', async () => {
    const h = io()
    const stopped = lookups(history, [record('tab', { claudeSessionId: 'c1', running: false })])
    await expect(openResumed(stopped, { resume: 'c1' }, undefined, h)).rejects.toThrow(
      'no tab identity'
    )
    expect(h.restarted).toEqual([])
    const out = await openResumed(stopped, { resume: 'c1' }, 'caller', h)
    expect(out).toMatchObject({ result: { sessionId: 'tab', alreadyOpen: true, resumed: true } })
    expect(h.restarted).toEqual(['tab'])
    expect(h.focused).toEqual(['tab'])
  })

  it('a conversation nobody holds becomes a start with its own provider, directory, model and title (F1: no mode needed)', async () => {
    const out = await openResumed(lookups(history), { resume: 'x1', chat: true }, 'caller', io())
    expect(out).toEqual({
      payload: {
        resume: 'x1',
        chat: true,
        mode: 'codex',
        cwd: '/work/odoo',
        name: 'A codex thread',
        workspace: 'ws1',
        resumeSessionId: 'x1'
      }
    })
    const pi = await openResumed(lookups(history), { resume: 'p1' }, 'caller', io())
    expect(pi).toMatchObject({
      payload: { mode: 'pi', provider: 'openai', thinking: 'high', resumeSessionId: 'p1' }
    })
  })

  it('the caller’s mode, model, name, cwd and workspace win over the conversation’s; another provider is refused', async () => {
    const out = await openResumed(
      lookups(history),
      {
        resume: 'c1',
        mode: 'claude',
        model: 'opus',
        name: 'Mine',
        cwd: '/elsewhere',
        workspace: 'w9'
      },
      'caller',
      io()
    )
    expect(out).toMatchObject({
      payload: { mode: 'claude', model: 'opus', name: 'Mine', cwd: '/elsewhere', workspace: 'w9' }
    })
    await expect(
      openResumed(lookups(history), { resume: 'x1', mode: 'claude' }, 'caller', io())
    ).rejects.toThrow('Conversation "x1" is codex\'s; mode "claude" cannot resume it.')
    await expect(
      openResumed(lookups(history), { resume: 'c1', server: 'studio' }, 'caller', io())
    ).rejects.toThrow('omit server')
  })

  it('an unregistered workspace of the conversation is not named', async () => {
    const out = await openResumed(
      lookups([entry({ claudeSessionId: 'c1', workspaceId: 'ws-gone' })]),
      { resume: 'c1' },
      'caller',
      io()
    )
    expect(out).toMatchObject({ payload: { cwd: '/work/odoo' } })
    expect((out as { payload: Record<string, unknown> }).payload).not.toHaveProperty('workspace')
  })
})

describe('recordsWithStopped: the listing plus the stopped holders, by id, a chunk at a time', () => {
  it('reads the ids the listing lacks in chunks and says a failed read (round 2, N-F4; round 3, R6 R7)', async () => {
    const calls: Array<ReadonlyArray<string> | undefined> = []
    const listed = [record('a', { claudeSessionId: 'c-a', running: true })]
    const hosted = Array.from({ length: 2 * RECORDS_BY_ID_CHUNK + 10 }, (_, i) =>
      session(`h${i}`, 'ended')
    )
    const out = await recordsWithStopped(
      async (ids) => {
        calls.push(ids)
        if (!ids) return listed
        return ids.map((id) => record(id, { claudeSessionId: `c-${id}`, running: true }))
      },
      async () => [session('a', 'idle'), ...hosted]
    )
    expect(calls[0]).toBeUndefined()
    expect(calls.slice(1).map((c) => c?.length)).toEqual([
      RECORDS_BY_ID_CHUNK,
      RECORDS_BY_ID_CHUNK,
      10
    ])
    expect(out.map((r) => r.id)).toEqual(['a', ...hosted.map((s) => s.id)])
    await expect(
      recordsWithStopped(
        async (ids) => {
          if (ids) throw new Error('the server did not answer')
          return listed
        },
        async () => [session('a', 'idle'), session('h1', 'ended')]
      )
    ).rejects.toThrow('the server did not answer')
  })

  it('reads nothing more when the listing holds every session', async () => {
    const calls: unknown[] = []
    const listed = [record('a', { claudeSessionId: 'c-a', running: true })]
    const out = await recordsWithStopped(
      async (ids) => {
        calls.push(ids)
        return listed
      },
      async () => [session('a', 'idle')]
    )
    expect(calls).toEqual([undefined])
    expect(out).toBe(listed)
  })
})
