import { describe, expect, it, vi } from 'vitest'
import type { ClaveApiClient } from '@clave/client'
import type { LayoutSnapshot } from '@clave/contract/sidebar'
import type { Session } from '@clave/contract/sessions'
import { applyWorkChange, type WorkAssignment, type WorkChange } from '@clave/contract/work-rules'
import type { SessionRecord } from '../sessions/adapters/pty-backend'
import type { ServedContext, ServedShell } from './served-core'
import { serveCommand } from './served-tools'

vi.mock('./roads', () => ({ noteRoad: vi.fn() }))

/**
 * The two work tools on the server road (PRDCT-4123), over fakes: the call
 * reaches the server's ChangeSessionWork with the change the arguments say,
 * the reach rule of the messaging tools gates assigning another tab, and a
 * refusal comes back in the rule's own words.
 */
const ID = {
  lead: '00000000-0000-4000-8000-0000000000a1',
  next: '00000000-0000-4000-8000-0000000000a2',
  stranger: '00000000-0000-4000-8000-0000000000a3',
  child: '00000000-0000-4000-8000-0000000000a4'
}

const session = (id: string): Session => ({
  id,
  provider: 'claude',
  transport: 'pty',
  cwd: '/work',
  windowKey: 'wA',
  state: 'idle',
  createdAt: 0,
  adapterId: 'pty',
  title: `title-${id}`
})

interface World {
  works: Map<string, WorkAssignment | undefined>
  calls: [string, WorkChange][]
  ctx: (caller: string | undefined) => ServedContext
}

function world(groupIds: string[] = [ID.lead, ID.next]): World {
  const works = new Map<string, WorkAssignment | undefined>()
  const records: Record<string, SessionRecord> = {}
  for (const id of Object.values(ID))
    records[id] = {
      id,
      cwd: '/work',
      folderName: 'work',
      claudeMode: true,
      antigravityMode: false,
      codexMode: false,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: false,
      displayName: `name-${id}`,
      ...(id === ID.child ? { spawnedBy: ID.lead } : {})
    }
  const calls: [string, WorkChange][] = []
  const layouts: LayoutSnapshot[] = [
    {
      windowKey: 'wA',
      revision: 0,
      displayOrder: ['g1'],
      groups: [
        { id: 'g1', name: 'Wave', sessionIds: groupIds, collapsed: false, cwd: null, terminals: [] }
      ]
    }
  ]
  const api = {
    sessions: {
      get: async (id: string) => {
        if (!records[id]) throw { _tag: 'SessionNotFound', id }
        return session(id)
      },
      changeWork: async (id: string, change: WorkChange) => {
        calls.push([id, change])
        try {
          const all = Object.keys(records).map((sid) => ({ id: sid, work: works.get(sid) }))
          const updates = applyWorkChange(all, id, change, 1_000 + calls.length)
          for (const u of updates) works.set(u.id, u.work ?? undefined)
          return { changed: updates, renamed: [] }
        } catch (err) {
          throw { _tag: 'WorkChangeRefused', id, message: (err as Error).message }
        }
      }
    },
    sidebar: { listLayouts: async () => layouts }
  } as unknown as ClaveApiClient
  const shell = {
    keyOf: () => 'wA',
    // main's own memory of the opens is empty: the record's parent link answers.
    parentOf: () => null,
    record: (id: string) => (records[id] ? { ...records[id], work: works.get(id) } : undefined)
  } as unknown as ServedShell
  const ctx = (caller: string | undefined): ServedContext =>
    ({
      api,
      shell,
      win: { id: 1 },
      callerSessionId: caller,
      requestView: vi.fn()
    }) as unknown as ServedContext
  return { works, calls, ctx }
}

describe('clave_set_work on the server road', () => {
  it('assigns the caller by default, and a tab in its group by id', async () => {
    const w = world()
    const own = (await serveCommand(
      'setWork',
      { unit: 'lane-a', kind: 'lane', label: 'Pair the phone', role: 'lead' },
      w.ctx(ID.lead)
    )) as { sessionId: string; work: WorkAssignment }
    expect(own.sessionId).toBe(ID.lead)
    expect(own.work).toMatchObject({ unit: 'lane-a', role: 'lead', standing: 'current' })
    // No unit: the caller's own unit.
    await serveCommand('setWork', { sessionId: ID.next, role: 'verifier' }, w.ctx(ID.lead))
    expect(w.works.get(ID.next)).toMatchObject({ unit: 'lane-a', role: 'verifier' })
    expect(w.calls.map(([id]) => id)).toEqual([ID.lead, ID.next])
  })

  it('reaches a tab the caller opened, and refuses a stranger before any change', async () => {
    const w = world([ID.lead])
    await serveCommand(
      'setWork',
      { unit: 'lane-a', kind: 'lane', label: 'L', role: 'lead' },
      w.ctx(ID.lead)
    )
    await serveCommand('setWork', { sessionId: ID.child, role: 'worker' }, w.ctx(ID.lead))
    expect(w.works.get(ID.child)?.role).toBe('worker')
    await expect(
      serveCommand('setWork', { sessionId: ID.stranger, role: 'worker' }, w.ctx(ID.lead))
    ).rejects.toThrow(/not related to yours/)
    expect(w.calls.some(([id]) => id === ID.stranger)).toBe(false)
  })

  it("answers the rule's refusal in its own words, and refuses a call with no tab", async () => {
    const w = world()
    await serveCommand(
      'setWork',
      { unit: 'lane-a', kind: 'lane', label: 'L', role: 'lead' },
      w.ctx(ID.lead)
    )
    await expect(serveCommand('setWork', { role: 'lead' }, w.ctx(ID.next))).rejects.toThrow(
      /Name the unit/
    )
    await expect(
      serveCommand('setWork', { unit: 'lane-a', role: 'lead' }, w.ctx(ID.next))
    ).rejects.toThrow(/already has a current lead/)
    await expect(serveCommand('setWork', { role: 'lead' }, w.ctx(undefined))).rejects.toThrow(
      /no tab identity/
    )
  })
})

describe('clave_hand_over on the server road', () => {
  it('offers to a successor in the group, who accepts; the holder is superseded', async () => {
    const w = world()
    await serveCommand(
      'setWork',
      { unit: 'lane-a', kind: 'lane', label: 'L', role: 'lead' },
      w.ctx(ID.lead)
    )
    const offered = (await serveCommand('handOver', { to: ID.next }, w.ctx(ID.lead))) as {
      changed: { sessionId: string }[]
    }
    expect(offered.changed.map((c) => c.sessionId)).toEqual([ID.next])
    expect(w.works.get(ID.next)?.standing).toBe('pending')
    await serveCommand('handOver', { accept: true }, w.ctx(ID.next))
    expect(w.works.get(ID.next)?.standing).toBe('current')
    expect(w.works.get(ID.lead)?.standing).toBe('superseded')
  })

  it('refuses a successor outside its reach, and an ambiguous call', async () => {
    const w = world([ID.lead])
    await serveCommand(
      'setWork',
      { unit: 'lane-a', kind: 'lane', label: 'L', role: 'lead' },
      w.ctx(ID.lead)
    )
    await expect(serveCommand('handOver', { to: ID.stranger }, w.ctx(ID.lead))).rejects.toThrow(
      /not related to yours/
    )
    await expect(
      serveCommand('handOver', { to: ID.next, accept: true }, w.ctx(ID.lead))
    ).rejects.toThrow(/exactly one of/)
    await expect(serveCommand('handOver', {}, w.ctx(ID.lead))).rejects.toThrow(/exactly one of/)
  })
})
