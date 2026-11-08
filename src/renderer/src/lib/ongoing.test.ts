import { describe, expect, it } from 'vitest'
import {
  attentionCount,
  entriesInWorkspace,
  entryFromSession,
  ongoingSessionIds,
  launchOfRecord,
  relativeTime,
  resumableConversation,
  sameLaunch,
  sessionOfEntry,
  sortEntries,
  splitOngoingDead,
  statusOf,
  type OngoingEntry,
  type OngoingSessionLike
} from './ongoing'

function tab(over: Partial<OngoingSessionLike> = {}): OngoingSessionLike {
  return {
    id: 'tab-1',
    name: 'email thread: reprise',
    cwd: '/work',
    alive: true,
    claudeMode: true,
    dangerousMode: false,
    claudeSessionId: 'conv-1',
    sessionType: 'local',
    workspaceId: 'ws-a',
    ...over
  }
}

function entry(over: Partial<OngoingEntry> = {}): OngoingEntry {
  return {
    id: 'e1',
    workspaceId: 'ws-a',
    sessionId: 'tab-1',
    provider: 'claude',
    conversationId: 'conv-1',
    name: 'email thread: reprise',
    cwd: '/work',
    note: '',
    originGroup: null,
    addedAt: 1000,
    launch: {},
    ...over
  }
}

describe('resumableConversation', () => {
  it('names the Claude conversation of a Claude tab', () => {
    expect(resumableConversation(tab())).toEqual({ provider: 'claude', conversationId: 'conv-1' })
  })
  it('names the Pi conversation of a Pi tab, never its Claude id', () => {
    expect(
      resumableConversation(
        tab({ claudeMode: false, piMode: true, piSessionId: 'pi-1', claudeSessionId: 'x' })
      )
    ).toEqual({ provider: 'pi', conversationId: 'pi-1' })
  })
  it('refuses a tab with no conversation yet, a terminal, a Codex tab and an agent row', () => {
    expect(resumableConversation(tab({ claudeSessionId: null }))).toBeNull()
    expect(resumableConversation(tab({ claudeMode: false, claudeSessionId: null }))).toBeNull()
    expect(resumableConversation(tab({ claudeMode: false }))).toBeNull()
    expect(resumableConversation(tab({ sessionType: 'agent' }))).toBeNull()
  })
})

describe('entryFromSession', () => {
  it('keeps what a resume needs and where the tab came from', () => {
    const e = entryFromSession(
      tab({ model: 'opus', dangerousMode: true, claudeProfileId: 'p2', claudeProfileLabel: 'Two' }),
      { id: 'e9', now: 5, originGroup: { id: 'g1', name: 'Admin' } }
    )
    expect(e).toMatchObject({
      id: 'e9',
      sessionId: 'tab-1',
      workspaceId: 'ws-a',
      provider: 'claude',
      conversationId: 'conv-1',
      originGroup: { id: 'g1', name: 'Admin' },
      addedAt: 5,
      note: '',
      launch: {
        model: 'opus',
        dangerousMode: true,
        claudeProfileId: 'p2',
        claudeProfileLabel: 'Two'
      }
    })
  })
  it('makes no entry for a tab that could not come back', () => {
    expect(
      entryFromSession(tab({ claudeSessionId: null }), { id: 'x', now: 0, originGroup: null })
    ).toBeNull()
  })
})

describe('sessionOfEntry and ongoingSessionIds', () => {
  it('finds the tab by its id first, then by the conversation it runs', () => {
    const a = tab({ id: 'tab-1' })
    const b = tab({ id: 'tab-2', claudeSessionId: 'conv-1' })
    expect(sessionOfEntry(entry(), [b, a])).toBe(a)
    expect(sessionOfEntry(entry({ sessionId: 'gone' }), [b])).toBe(b)
    expect(sessionOfEntry(entry({ sessionId: 'gone', provider: 'pi' }), [b])).toBeUndefined()
  })
  it('hides the tab it found and the tab it names, and nothing else', () => {
    const ids = ongoingSessionIds(
      [entry({ sessionId: 'not-yet-here' })],
      [
        tab({ id: 'resumed', claudeSessionId: 'conv-1' }),
        tab({ id: 'other', claudeSessionId: 'c2' })
      ]
    )
    expect([...ids].sort()).toEqual(['not-yet-here', 'resumed'])
  })
})

describe('entriesInWorkspace', () => {
  it('keeps the workspace’s own and the unscoped ones', () => {
    const list = [
      entry({ id: 'a', workspaceId: 'ws-a' }),
      entry({ id: 'b', workspaceId: 'ws-b' }),
      entry({ id: 'c', workspaceId: null })
    ]
    expect(entriesInWorkspace(list, 'ws-a').map((e) => e.id)).toEqual(['a', 'c'])
    expect(entriesInWorkspace(list, null).map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('statusOf, sortEntries, attentionCount', () => {
  it('says where a conversation stands', () => {
    expect(statusOf(undefined)).toBe('resting')
    expect(statusOf(tab({ alive: false }))).toBe('resting')
    expect(statusOf(tab({ agentState: 'blocked' }))).toBe('waiting')
    expect(statusOf(tab({ promptWaiting: 'question' }))).toBe('waiting')
    expect(statusOf(tab({ agentState: 'working' }))).toBe('working')
    expect(statusOf(tab({ hasUnseenActivity: true }))).toBe('unread')
    expect(statusOf(tab())).toBe('open')
    expect(statusOf(undefined, true)).toBe('elsewhere')
    expect(statusOf(tab({ alive: false }), true)).toBe('elsewhere')
    expect(statusOf(tab(), true)).toBe('open')
  })
  it('puts what asks for the person first, then the newest kept', () => {
    const rows = [
      { entry: entry({ id: 'old', addedAt: 1 }), status: 'open' as const },
      { entry: entry({ id: 'new', addedAt: 9 }), status: 'open' as const },
      { entry: entry({ id: 'rest', addedAt: 99 }), status: 'resting' as const },
      { entry: entry({ id: 'away', addedAt: 50 }), status: 'elsewhere' as const },
      { entry: entry({ id: 'ask', addedAt: 0 }), status: 'waiting' as const },
      { entry: entry({ id: 'read', addedAt: 0 }), status: 'unread' as const }
    ]
    expect(sortEntries(rows).map((r) => r.entry.id)).toEqual([
      'ask',
      'read',
      'new',
      'old',
      'away',
      'rest'
    ])
  })
  it('counts the waiting and the unread only', () => {
    expect(attentionCount(['waiting', 'unread', 'working', 'open', 'resting'])).toBe(2)
  })
})

describe('splitOngoingDead', () => {
  it('keeps an ongoing tab out of the restore prompt, by its id or its conversation', () => {
    const records = [
      { id: 'tab-1' },
      { id: 'tab-7', claudeSessionId: 'conv-7' },
      { id: 'tab-8', piSessionId: 'pi-8' },
      { id: 'work', claudeSessionId: 'conv-w' }
    ]
    const { restore, resting } = splitOngoingDead(records, [
      entry(),
      entry({ id: 'e7', sessionId: 'x', conversationId: 'conv-7' }),
      entry({ id: 'e8', sessionId: 'y', provider: 'pi', conversationId: 'pi-8' })
    ])
    expect(resting.map((r) => r.id)).toEqual(['tab-1', 'tab-7', 'tab-8'])
    expect(restore.map((r) => r.id)).toEqual(['work'])
  })
  it('never matches a Claude record on a Pi entry’s id', () => {
    const { resting } = splitOngoingDead(
      [{ id: 'z', claudeSessionId: 'same' }],
      [entry({ sessionId: 'q', provider: 'pi', conversationId: 'same' })]
    )
    expect(resting).toEqual([])
  })
})

describe('splitOngoingDead keeps what the dropped record knew', () => {
  it('takes the account, the model and the folder of the record into the entry', () => {
    const { entries } = splitOngoingDead(
      [
        {
          id: 'tab-1',
          cwd: '/moved',
          model: 'opus',
          claudeProfileId: 'acct-2',
          claudeProfileLabel: 'Two',
          configDir: '/acct-2'
        }
      ],
      [
        entry({ launch: { claudeProfileId: 'acct-1', claudeConfigDir: '/acct-1' } }),
        entry({ id: 'other', sessionId: 'z', conversationId: 'cz' })
      ]
    )
    expect(entries[0]).toMatchObject({
      cwd: '/moved',
      launch: {
        model: 'opus',
        claudeProfileId: 'acct-2',
        claudeProfileLabel: 'Two',
        claudeConfigDir: '/acct-2'
      }
    })
    expect(entries[1]).toEqual(entry({ id: 'other', sessionId: 'z', conversationId: 'cz' }))
  })
  it('takes the launch from the record of the tab it names, never an older one', () => {
    const e = entry({
      sessionId: 'tab-2',
      launch: { claudeProfileId: 'acct-2', claudeConfigDir: '/acct-2' }
    })
    const own = {
      id: 'tab-2',
      cwd: '/work',
      claudeSessionId: 'conv-1',
      claudeProfileId: 'acct-2',
      configDir: '/acct-2'
    }
    const stale = {
      id: 'tab-1',
      cwd: '/work',
      claudeSessionId: 'conv-1',
      claudeProfileId: 'acct-1',
      configDir: '/acct-1'
    }
    for (const order of [
      [own, stale],
      [stale, own]
    ]) {
      const r = splitOngoingDead(order, [e])
      expect(r.resting.map((x) => x.id).sort()).toEqual(['tab-1', 'tab-2'])
      expect(r.entries[0].launch.claudeConfigDir).toBe('/acct-2')
    }
  })
  it('leaves an entry the record agrees with as it was', () => {
    const e = entry({ launch: { model: 'opus' } })
    const out = splitOngoingDead([{ id: 'tab-1', cwd: '/work', model: 'opus' }], [e])
    expect(out.entries[0]).toBe(e)
  })
  it('reads the launch of a record and compares launches field by field', () => {
    expect(launchOfRecord({ id: 'r', configDir: '/d', dangerousMode: true })).toEqual({
      claudeConfigDir: '/d',
      dangerousMode: true
    })
    expect(sameLaunch({ model: 'a' }, { model: 'a' })).toBe(true)
    expect(sameLaunch({ model: 'a' }, {})).toBe(false)
  })
})

describe('relativeTime', () => {
  const now = 10_000_000_000
  it('reads as a person would say it', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 hours ago')
    expect(relativeTime(now - 26 * 3_600_000, now)).toBe('yesterday')
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe('4 days ago')
    expect(relativeTime(now - 21 * 86_400_000, now)).toBe('3 weeks ago')
  })
})
