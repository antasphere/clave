import { describe, expect, it, vi } from 'vitest'
import type { SessionRecord, SessionRecordFields } from '@clave/contract/sessions'
import { adoptRunningChats } from './adopt-running-chats'

const scope = { windowKey: 'primary', primary: true, knownWindowKeys: ['primary', 'secondary'] }
const chat = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord =>
  ({
    id,
    cwd: '/workspace',
    folderName: 'workspace',
    transport: 'events',
    running: true,
    workspaceId: 'hidden-workspace',
    codexThreadId: 'original-thread',
    ...extra
  }) as SessionRecord

function host(initial: SessionRecord[]): {
  records: Map<string, SessionRecord>
  list: ReturnType<typeof vi.fn<(ids?: string[]) => Promise<SessionRecord[]>>>
  keep: ReturnType<typeof vi.fn<(id: string, fields: SessionRecordFields) => Promise<void>>>
  bind: ReturnType<typeof vi.fn<(id: string, windowKey: string) => void>>
} {
  const records = new Map(initial.map((r) => [r.id, r]))
  return {
    records,
    list: vi.fn(async (ids?: string[]) =>
      [...records.values()].filter((r) => !ids || ids.includes(r.id))
    ),
    keep: vi.fn(async (id: string, fields: SessionRecordFields) => {
      const record = records.get(id)
      if (record && fields.window && (record.windowKey || null) === fields.window.expectedKey)
        records.set(id, { ...record, windowKey: fields.window.key })
    }),
    bind: vi.fn()
  }
}

describe('desktop adoption of running local orphan chats', () => {
  it('keeps identity and workspace, persists the primary owner, and is idempotent', async () => {
    const source = host([chat('windowless'), chat('lost-window', { windowKey: 'gone' })])
    expect(await adoptRunningChats(scope, source)).toEqual([
      chat('windowless', { windowKey: 'primary' }),
      chat('lost-window', { windowKey: 'primary' })
    ])
    expect(source.keep.mock.calls).toEqual([
      ['windowless', { window: { key: 'primary', expectedKey: null } }],
      ['lost-window', { window: { key: 'primary', expectedKey: 'gone' } }]
    ])
    expect(source.bind.mock.calls).toEqual([
      ['windowless', 'primary'],
      ['lost-window', 'primary']
    ])
    expect(await adoptRunningChats(scope, source)).toHaveLength(2)
    expect(source.keep).toHaveBeenCalledTimes(2)
    expect(source.bind).toHaveBeenCalledTimes(4)
  })

  it('a secondary recovers its own hosted chat without claiming an orphan or another window', async () => {
    const source = host([
      chat('windowless'),
      chat('mine', { windowKey: 'secondary' }),
      chat('other', { windowKey: 'primary' })
    ])
    expect(
      await adoptRunningChats({ ...scope, windowKey: 'secondary', primary: false }, source)
    ).toEqual([chat('mine', { windowKey: 'secondary' })])
    expect(source.keep).not.toHaveBeenCalled()
    expect(source.bind).toHaveBeenCalledExactlyOnceWith('mine', 'secondary')
  })

  it('leaves desktop-owned, persisted-window, stopped, terminal and hidden sessions alone', async () => {
    const source = host([
      chat('other', { windowKey: 'secondary' }),
      chat('stopped', { running: false }),
      chat('terminal', { transport: 'pty' }),
      chat('routine', { link: { kind: 'routine', routineKey: 'r', runId: 'run' } }),
      chat('serving', { link: { kind: 'session-view', ownerId: 'mine' } })
    ])
    expect(await adoptRunningChats(scope, source)).toEqual([])
    expect(source.keep).not.toHaveBeenCalled()
    expect(source.bind).not.toHaveBeenCalled()
  })

  it('does not bind a stale claim after a move to another window wins', async () => {
    const source = host([chat('moving')])
    source.keep.mockImplementation(async (id, fields) => {
      source.records.set(id, chat(id, { windowKey: 'secondary' }))
      // The host's conditional claim must not overwrite this newer stamp.
      expect(fields.window?.expectedKey).toBe(null)
    })
    expect(await adoptRunningChats(scope, source)).toEqual([])
    expect(source.bind).not.toHaveBeenCalled()
  })

  it('does not surface a chat closed while its claim was on the wire', async () => {
    const source = host([chat('closing')])
    source.keep.mockImplementation(async (id) => {
      source.records.delete(id)
    })
    expect(await adoptRunningChats(scope, source)).toEqual([])
    expect(source.bind).not.toHaveBeenCalled()
  })
})
