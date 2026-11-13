import { describe, expect, it } from 'vitest'
import type { Session, SessionRecord } from '@clave/contract/sessions'
import { sessionKey } from '@clave/contract/fleet'
import type { HistoryListEntry, HistoryServerRef } from '../session-history/service'
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
      piThinking: null,
      launch: null
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
      },
      isKnownAccount: (provider, id) => provider === 'claude' && id === 'acc-anthropic'
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

  it('an account named with resume never moves the tab that holds the conversation: a pinned tab stays put (PRDCT-4328)', async () => {
    const h = io()
    const stopped = lookups(history, [record('tab', { claudeSessionId: 'c1', running: false })])
    // The holder is resumed in place on the account it runs on: the restart
    // takes the tab's id alone, so `account` cannot reach it, pinned or not.
    const out = await openResumed(stopped, { resume: 'c1', account: 'Play' }, 'caller', h)
    expect(out).toMatchObject({ result: { sessionId: 'tab', alreadyOpen: true, resumed: true } })
    expect(out).not.toHaveProperty('payload')
    expect(h.restarted).toEqual(['tab'])
    // A tab on a Clave server is not this Mac's History's: refused, never
    // reopened elsewhere on another account.
    await expect(
      openResumed(stopped, { resume: 'c1', server: 'srv-b', account: 'Play' }, 'caller', h)
    ).rejects.toThrow(/omit server/)
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

describe('openResumed: the launch the ledger remembers is the default (PRDCT-4236)', () => {
  const io: ResumeOpenIo = {
    isDirectory: () => true,
    isRegisteredWorkspace: () => true,
    restart: async () => ({ resumed: false }),
    focus: async () => {},
    isKnownAccount: (provider, id) => provider === 'claude' && id === 'acc-anthropic'
  }
  const payloadOf = (out: unknown): Record<string, unknown> =>
    (out as { payload: Record<string, unknown> }).payload

  it('bypass, the effort and a known account come back when the caller names none', async () => {
    const out = await openResumed(
      lookups([
        entry({
          claudeSessionId: 'c1',
          launch: { dangerous: true, effort: 'high', accountId: 'acc-anthropic' }
        })
      ]),
      { resume: 'c1' },
      'caller',
      io
    )
    expect(payloadOf(out)).toMatchObject({
      dangerous: true,
      effort: 'high',
      account: 'acc-anthropic',
      resumeSessionId: 'c1'
    })
    expect(payloadOf(out)).not.toHaveProperty('permissionMode')
  })

  it('a mode short of bypass comes back as the mode, bypass kept reachable when it was launched with it', async () => {
    const out = await openResumed(
      lookups([
        entry({ claudeSessionId: 'c1', launch: { dangerous: true, permissionMode: 'plan' } })
      ]),
      { resume: 'c1' },
      'caller',
      io
    )
    expect(payloadOf(out)).toMatchObject({
      dangerous: false,
      permissionMode: 'plan',
      allowDangerous: true
    })
  })

  it('the caller’s dangerous, permissionMode, effort and account win', async () => {
    const launched = lookups([
      entry({
        claudeSessionId: 'c1',
        launch: {
          dangerous: true,
          permissionMode: 'plan',
          effort: 'high',
          accountId: 'acc-anthropic'
        }
      })
    ])
    const out = payloadOf(
      await openResumed(
        launched,
        { resume: 'c1', dangerous: false, effort: 'low', account: 'other' },
        'caller',
        io
      )
    )
    expect(out).toMatchObject({ dangerous: false, effort: 'low', account: 'other' })
    expect(out).not.toHaveProperty('permissionMode')
    const mode = payloadOf(
      await openResumed(launched, { resume: 'c1', permissionMode: 'acceptEdits' }, 'caller', io)
    )
    expect(mode).toMatchObject({ permissionMode: 'acceptEdits' })
    expect(mode).not.toHaveProperty('dangerous')
  })

  it('an account no longer on this Mac is not named: the pool picks, as before', async () => {
    const out = payloadOf(
      await openResumed(
        lookups([entry({ claudeSessionId: 'c1', launch: { accountId: 'acc-gone' } })]),
        { resume: 'c1' },
        'caller',
        io
      )
    )
    expect(out).not.toHaveProperty('account')
    expect(out).not.toHaveProperty('dangerous')
  })

  it('clave_history rows carry the launch', async () => {
    const { rows } = await listConversations(
      lookups([entry({ claudeSessionId: 'c1', launch: { dangerous: true } })])
    )
    expect(rows[0].launch).toEqual({ dangerous: true })
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

/**
 * PRDCT-4321: a server's conversation in the History. Its row says the
 * server and whether a tab of that server holds it; it resumes only while
 * the server is online, on that server, never on this Mac, and its folder is
 * the server's, never checked on this disk.
 */
describe('a server’s conversation in the agent tools (PRDCT-4321)', () => {
  const TAB_KEY = sessionKey({ serverId: 'srv', sessionId: 'tab-1' })
  const onServer = (
    online: boolean,
    held: HistoryServerRef['held'],
    over: Partial<HistoryListEntry> = {}
  ): HistoryListEntry =>
    entry({
      claudeSessionId: 'sc1',
      source: 'server',
      sessionId: TAB_KEY,
      cwd: '/srv/odoo',
      workspaceId: null,
      title: 'Studio research',
      server: { id: 'srv', name: 'Studio', online, held },
      ...over
    })
  const gone = (e: HistoryListEntry): HistoryListEntry => ({
    ...e,
    transcript: { ...e.transcript, exists: false }
  })
  const io = (): ResumeOpenIo & { restarted: string[]; focused: string[] } => {
    const restarted: string[] = []
    const focused: string[] = []
    return {
      restarted,
      focused,
      // Nothing of the server's disk is a folder of this Mac.
      isDirectory: () => false,
      isRegisteredWorkspace: () => false,
      restart: async (id) => {
        restarted.push(id)
        return { resumed: true }
      },
      focus: async (id) => {
        focused.push(id)
      },
      isKnownAccount: () => false
    }
  }

  describe('listConversations', () => {
    it('reports the server, the tab of the server that holds it, and resumable only online', async () => {
      const row = async (e: HistoryListEntry): Promise<Record<string, unknown>> =>
        (await listConversations(lookups([e]))).rows[0] as unknown as Record<string, unknown>
      expect(await row(onServer(true, 'running'))).toMatchObject({
        server: { id: 'srv', name: 'Studio', online: true },
        open: { sessionId: TAB_KEY, alive: true },
        resumable: true
      })
      expect(await row(onServer(true, 'stopped'))).toMatchObject({
        open: { sessionId: TAB_KEY, alive: false }
      })
      expect(await row(onServer(true, 'closed'))).toMatchObject({ open: null, resumable: true })
      expect(await row(onServer(true, null))).toMatchObject({ open: null })
      // A row the server does not list is tried there while it is online,
      // whatever this Mac's disk says of its transcript; offline, never.
      expect(await row(gone(onServer(true, null)))).toMatchObject({ resumable: true })
      expect(await row(gone(onServer(false, null)))).toMatchObject({ resumable: false })
      expect(await row(gone(onServer(true, 'closed')))).toMatchObject({ resumable: false })
      expect(await row(onServer(false, 'closed'))).toMatchObject({
        server: { id: 'srv', name: 'Studio', online: false },
        resumable: false
      })
      // The server row carries no `held` of its own.
      expect((await row(onServer(true, 'running'))).server).toEqual({
        id: 'srv',
        name: 'Studio',
        online: true
      })
    })

    it('never takes one of this Mac’s records as the holder of a server’s conversation', async () => {
      const { rows } = await listConversations(
        lookups(
          [onServer(true, 'closed')],
          [record('mac-tab', { claudeSessionId: 'sc1', running: true })],
          [session('mac-tab', 'idle')]
        )
      )
      expect(rows[0].open).toBeNull()
    })
  })

  describe('planResume', () => {
    const dirExists = (): boolean => false

    it('refuses an offline server’s conversation, naming the server', async () => {
      await expect(
        planResume(lookups([onServer(false, 'closed')]), 'sc1', dirExists)
      ).rejects.toThrow(
        'Conversation "sc1" ("Studio research") ran on the server "Studio", which is offline'
      )
      await expect(
        planResume(lookups([onServer(false, 'running')]), 'sc1', dirExists)
      ).rejects.toBeInstanceOf(ResumeRefused)
    })

    it('answers the tab of the server that holds it, running or stopped, whatever its transcript', async () => {
      expect(await planResume(lookups([onServer(true, 'running')]), 'sc1', dirExists)).toEqual({
        kind: 'server-held',
        sessionId: TAB_KEY,
        alive: true,
        server: { id: 'srv', name: 'Studio' }
      })
      expect(
        await planResume(lookups([gone(onServer(true, 'stopped'))]), 'sc1', dirExists)
      ).toEqual({
        kind: 'server-held',
        sessionId: TAB_KEY,
        alive: false,
        server: { id: 'srv', name: 'Studio' }
      })
    })

    it('refuses a closed conversation whose transcript left the server, naming the server', async () => {
      await expect(
        planResume(lookups([gone(onServer(true, 'closed'))]), 'sc1', dirExists)
      ).rejects.toThrow(
        'The transcript of conversation "sc1" ("Studio research") is no longer on the server "Studio"'
      )
    })

    it('starts a conversation its online server does not list there, its transcript unchecked', async () => {
      const exists = (p: string): boolean => {
        throw new Error(`dirExists asked for ${p}`)
      }
      // This Mac sees no transcript: it is on the server's disk, if anywhere.
      expect(await planResume(lookups([gone(onServer(true, null))]), 'sc1', exists)).toMatchObject({
        kind: 'start',
        cwd: '/srv/odoo',
        server: { id: 'srv', name: 'Studio' }
      })
      await expect(
        planResume(lookups([onServer(true, null, { cwd: '' })]), 'sc1', exists)
      ).rejects.toThrow('names no working directory')
    })

    it('refuses a conversation an offline server does not list, naming the server', async () => {
      await expect(planResume(lookups([onServer(false, null)]), 'sc1', dirExists)).rejects.toThrow(
        'ran on the server "Studio", which is offline'
      )
    })

    it('starts a closed conversation on its server, its folder never checked on this Mac', async () => {
      const exists = (p: string): boolean => {
        throw new Error(`dirExists asked for ${p}`)
      }
      expect(await planResume(lookups([onServer(true, 'closed')]), 'sc1', exists)).toEqual({
        kind: 'start',
        cwd: '/srv/odoo',
        provider: 'claude',
        title: 'Studio research',
        model: 'claude-opus-5-5',
        workspaceId: null,
        piProvider: null,
        piThinking: null,
        launch: null,
        server: { id: 'srv', name: 'Studio' }
      })
      expect(await planResume(lookups([onServer(true, 'closed')]), 'sc1', dirExists)).toMatchObject(
        { kind: 'start', server: { id: 'srv', name: 'Studio' } }
      )
    })
  })

  describe('openResumed', () => {
    it('refuses a server conversation asked of another server or of this Mac', async () => {
      const h = lookups([onServer(true, 'closed')])
      for (const server of ['other', 'local']) {
        await expect(openResumed(h, { resume: 'sc1', server }, 'caller', io())).rejects.toThrow(
          'Conversation "sc1" ran on the server "Studio" and reopens there; omit server or name that one.'
        )
      }
    })

    it('accepts its server by id or by name, in any case, and the start goes there', async () => {
      const h = lookups([onServer(true, 'closed')])
      for (const server of [undefined, 'srv', 'SRV', 'Studio', 'studio', ' STUDIO ']) {
        const out = await openResumed(
          h,
          { resume: 'sc1', ...(server !== undefined ? { server } : {}) },
          'caller',
          io()
        )
        expect(out).toMatchObject({
          payload: {
            mode: 'claude',
            cwd: '/srv/odoo',
            server: 'srv',
            resumeSessionId: 'sc1'
          }
        })
      }
    })

    it('answers the tab of the server that holds it, restarting nothing', async () => {
      for (const held of ['running', 'stopped'] as const) {
        const h = io()
        const out = await openResumed(
          lookups([onServer(true, held)]),
          { resume: 'sc1', server: 'Studio' },
          'caller',
          h
        )
        expect(out).toMatchObject({
          result: {
            sessionId: TAB_KEY,
            conversation: 'sc1',
            alreadyOpen: true,
            resumed: false,
            server: 'Studio'
          }
        })
        expect(h.restarted).toEqual([])
        expect(h.focused).toEqual([])
      }
    })

    it('reopens a server’s conversation on the profile and the server account it ran on', async () => {
      const ranOn = onServer(true, 'closed', {
        launchProfileId: 'chat:claude:mine',
        launch: { accountId: 'srv-acct', accountLabel: 'Studio work' }
      })
      const h = io()
      const asked: string[] = []
      h.isKnownAccount = (_provider, id) => {
        asked.push(id)
        return true
      }
      const out = (await openResumed(lookups([ranOn]), { resume: 'sc1' }, 'caller', h)) as {
        payload: Record<string, unknown>
      }
      expect(out.payload).toMatchObject({
        server: 'srv',
        resumeSessionId: 'sc1',
        resumeLaunchProfileId: 'chat:claude:mine',
        resumeAccount: { id: 'srv-acct', label: 'Studio work' }
      })
      // The server's account is never looked up among this Mac's, nor sent
      // as one of this Mac's.
      expect(asked).toEqual([])
      expect(out.payload.account).toBeUndefined()
    })

    it('lets the caller’s own profile, chat or account win over the remembered ones', async () => {
      const ranOn = onServer(true, 'closed', {
        launchProfileId: 'chat:claude:mine',
        launch: { accountId: 'srv-acct', accountLabel: 'Studio work' }
      })
      for (const own of [{ profile: 'claude-chat' }, { chat: false }, { chat: true }]) {
        const out = (await openResumed(
          lookups([ranOn]),
          { resume: 'sc1', ...own },
          'caller',
          io()
        )) as { payload: Record<string, unknown> }
        expect(out.payload.resumeLaunchProfileId).toBeUndefined()
        expect(out.payload.resumeAccount).toEqual({ id: 'srv-acct', label: 'Studio work' })
      }
      const out = (await openResumed(
        lookups([ranOn]),
        { resume: 'sc1', account: 'other' },
        'caller',
        io()
      )) as { payload: Record<string, unknown> }
      expect(out.payload.resumeAccount).toBeUndefined()
      expect(out.payload.account).toBe('other')
      expect(out.payload.resumeLaunchProfileId).toBe('chat:claude:mine')
    })

    it('carries no remembered profile nor account for this Mac’s own conversation', async () => {
      const mine = lookups([
        entry({
          claudeSessionId: 'c1',
          launchProfileId: 'chat:claude:mine',
          launch: { accountId: 'mac-acct' }
        })
      ])
      const here = { ...io(), isDirectory: () => true, isKnownAccount: () => true }
      const out = (await openResumed(mine, { resume: 'c1' }, 'caller', here)) as {
        payload: Record<string, unknown>
      }
      expect(out.payload.resumeLaunchProfileId).toBeUndefined()
      expect(out.payload.resumeAccount).toBeUndefined()
      // This Mac's account is still named when it exists here.
      expect(out.payload.account).toBe('mac-acct')
    })

    it('accepts local for this Mac’s own conversation and refuses a server', async () => {
      const mine = lookups([entry({ claudeSessionId: 'c1' })])
      const here = { ...io(), isDirectory: (p: string) => p === '/work/odoo' }
      const out = await openResumed(mine, { resume: 'c1', server: 'local' }, 'caller', here)
      expect(out).toMatchObject({ payload: { cwd: '/work/odoo', resumeSessionId: 'c1' } })
      // The caller's own `local` rides through; no server is named for it.
      expect((out as { payload: Record<string, unknown> }).payload.server ?? 'local').toBe('local')
      await expect(
        openResumed(mine, { resume: 'c1', server: 'srv' }, 'caller', here)
      ).rejects.toThrow('Conversation "c1" is this Mac\'s and reopens here; omit server.')
    })
  })
})
