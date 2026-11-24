import { describe, expect, it, vi } from 'vitest'
import type { ClaveApiClient } from '@clave/client'
import type { Session } from '@clave/contract/sessions'
import { applyNest } from '@clave/contract/nest-rules'
import { sessionKey } from '@clave/contract/fleet'
import type { SessionRecord } from '../sessions/adapters/pty-backend'
import { NOT_SERVED, type ServedContext, type ServedShell } from './served-core'
import { serveCommand } from './served-tools'

vi.mock('./roads', () => ({ noteRoad: vi.fn() }))

/**
 * `clave_attach_session` on the server road (PRDCT-4997), over fakes: the
 * call reaches the server's NestSession with the two ids the arguments name,
 * a refusal comes back in the rule's own words, and an accepted nesting
 * places the tab and the tabs nested under it right after the parent, a
 * placement that fails leaving the answer as it is.
 */
const ID = {
  lead: '00000000-0000-4000-8000-0000000000b1',
  old: '00000000-0000-4000-8000-0000000000b2',
  helper: '00000000-0000-4000-8000-0000000000b3',
  far: '00000000-0000-4000-8000-0000000000b4'
}

const session = (id: string): Session => ({
  id,
  provider: 'claude',
  transport: 'pty',
  cwd: '/work',
  windowKey: id === ID.far ? 'wB' : 'wA',
  state: 'idle',
  createdAt: 0,
  adapterId: 'pty',
  title: `title-${id}`
})

interface World {
  links: Map<string, string>
  calls: [string, string | null][]
  moves: unknown[]
  failPlacement: () => void
  ctx: (caller: string | undefined) => ServedContext
}

function world(): World {
  // The helper is nested under the old tab: it moves with it.
  const links = new Map<string, string>([[ID.helper, ID.old]])
  const record = (id: string): SessionRecord => ({
    id,
    cwd: '/work',
    folderName: 'work',
    claudeMode: true,
    antigravityMode: false,
    codexMode: false,
    piMode: false,
    claudeAgentsMode: false,
    dangerousMode: false,
    windowKey: session(id).windowKey,
    ...(links.has(id) ? { spawnedBy: links.get(id) } : {})
  })
  const calls: [string, string | null][] = []
  const moves: unknown[] = []
  let placementFails = false
  const api = {
    sessions: {
      get: async (id: string) => {
        if (!Object.values(ID).includes(id)) throw { _tag: 'SessionNotFound', id }
        return session(id)
      },
      list: async () => Object.values(ID).map(session),
      nest: async (id: string, under: string | null) => {
        calls.push([id, under])
        try {
          const all = Object.values(ID).map((sid) => ({
            id: sid,
            under: links.get(sid) ?? null,
            windowKey: session(sid).windowKey
          }))
          const result = applyNest(all, id, under)
          if (result.under) links.set(id, result.under)
          else links.delete(id)
          return result
        } catch (err) {
          throw { _tag: 'NestRefused', id, message: (err as Error).message }
        }
      }
    },
    sidebar: {
      moveItems: async (input: unknown) => {
        if (placementFails) throw new Error('the layout is gone')
        moves.push(input)
        return { windowKey: 'wA', revision: 1, groups: [], displayOrder: [] }
      }
    }
  } as unknown as ClaveApiClient
  const shell = {
    keyOf: () => 'wA',
    parentOf: () => null,
    record: (id: string) => (Object.values(ID).includes(id) ? record(id) : undefined)
  } as unknown as ServedShell
  const ctx = (caller: string | undefined): ServedContext =>
    ({
      api,
      shell,
      win: { id: 1 },
      callerSessionId: caller,
      requestView: vi.fn()
    }) as unknown as ServedContext
  return {
    links,
    calls,
    moves,
    failPlacement: () => {
      placementFails = true
    },
    ctx
  }
}

describe('clave_attach_session on the server road', () => {
  it('nests a tab under another and places it after the parent, with its nested tabs', async () => {
    const w = world()
    const answer = await serveCommand(
      'attachSession',
      { sessionId: ID.old, to: ID.lead },
      w.ctx(ID.lead)
    )
    expect(answer).toEqual({ sessionId: ID.old, nestedUnder: ID.lead, changed: true })
    expect(w.calls).toEqual([[ID.old, ID.lead]])
    expect(w.moves).toEqual([
      { windowKey: 'wA', itemIds: [ID.old, ID.helper], targetId: ID.lead, position: 'after' }
    ])
  })

  it('nests the caller by default, under "mine" too', async () => {
    const w = world()
    expect(await serveCommand('attachSession', { to: ID.lead }, w.ctx(ID.old))).toEqual({
      sessionId: ID.old,
      nestedUnder: ID.lead,
      changed: true
    })
    await serveCommand('attachSession', { sessionId: ID.helper, to: 'mine' }, w.ctx(ID.lead))
    expect(w.calls).toEqual([
      [ID.old, ID.lead],
      [ID.helper, ID.lead]
    ])
  })

  it('takes a tab out with detach, and moves nothing', async () => {
    const w = world()
    expect(
      await serveCommand('attachSession', { sessionId: ID.helper, detach: true }, w.ctx(ID.lead))
    ).toEqual({ sessionId: ID.helper, nestedUnder: null, changed: true })
    expect(w.calls).toEqual([[ID.helper, null]])
    expect(w.links.has(ID.helper)).toBe(false)
    expect(w.moves).toEqual([])
  })

  it('answers the rule’s refusal in its own words, and moves nothing', async () => {
    const w = world()
    await expect(
      serveCommand('attachSession', { sessionId: ID.old, to: ID.far }, w.ctx(ID.lead))
    ).rejects.toThrow(
      'The two tabs are in different windows: move the tab into the other window first, then nest it'
    )
    expect(w.moves).toEqual([])
  })

  it('names an unknown tab, and refuses a call with no tab or with a bad pair of arguments', async () => {
    const w = world()
    const ghost = '00000000-0000-4000-8000-0000000000bf'
    await expect(
      serveCommand('attachSession', { sessionId: ghost, to: ID.lead }, w.ctx(ID.lead))
    ).rejects.toThrow(`No session with id "${ghost}"`)
    await expect(serveCommand('attachSession', { to: ghost }, w.ctx(ID.lead))).rejects.toThrow(
      `No session with id "${ghost}"`
    )
    await expect(serveCommand('attachSession', { to: ID.lead }, w.ctx(undefined))).rejects.toThrow(
      /no tab identity/
    )
    await expect(
      serveCommand('attachSession', { to: ID.lead, detach: true }, w.ctx(ID.old))
    ).rejects.toThrow(
      'Pass exactly one of: to (the tab it goes under) or detach: true (take it out)'
    )
    expect(w.calls).toEqual([])
  })

  it('a placement that fails never fails the tool: the link is written', async () => {
    const w = world()
    w.failPlacement()
    expect(
      await serveCommand('attachSession', { sessionId: ID.old, to: ID.lead }, w.ctx(ID.lead))
    ).toEqual({ sessionId: ID.old, nestedUnder: ID.lead, changed: true })
    expect(w.links.get(ID.old)).toBe(ID.lead)
  })

  it('leaves a tab of another Clave server to the window, by either argument', async () => {
    const w = world()
    const remote = sessionKey({ serverId: 'srv-1', sessionId: ID.old })
    expect(
      await serveCommand('attachSession', { sessionId: remote, to: ID.lead }, w.ctx(ID.lead))
    ).toBe(NOT_SERVED)
    expect(
      await serveCommand('attachSession', { sessionId: ID.old, to: remote }, w.ctx(ID.lead))
    ).toBe(NOT_SERVED)
    expect(w.calls).toEqual([])
  })
})
