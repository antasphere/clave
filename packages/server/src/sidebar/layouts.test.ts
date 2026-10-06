import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  GroupTerminal,
  MoveResult,
  SidebarEvent,
  SidebarGroup,
  WindowLayout
} from '@clave/contract/sidebar'
import { SidebarLayouts } from './layouts'
import { type SidebarHost, memorySidebarStorage, noWindowsHost } from './ports'

type Reason = 'not-live' | 'not-tmux' | 'same-window'

/** A shell the test configures: which windows exist, which is primary, and
 *  why a session cannot move. Every call it receives is recorded. */
class FakeHost implements SidebarHost {
  hostsWindows = true
  known = new Set<string>()
  live = new Set<string>()
  primary: string | null = null
  refuse = new Map<string, Reason>()
  readonly rehomed: Array<{
    sessionIds: string[]
    target: string
    options: { layout: WindowLayout | null; focus: boolean }
  }> = []
  readonly movedAway: Array<{ windowKey: string; groupId: string }> = []

  knownWindowKeys = (): ReadonlySet<string> => this.known
  isPrimary = (key: string): boolean => key === this.primary
  isLive = (key: string): boolean => this.live.has(key)
  movable = (ids: ReadonlyArray<string>): ReturnType<SidebarHost['movable']> => ({
    movable: ids.filter((id) => !this.refuse.has(id)),
    refused: ids
      .filter((id) => this.refuse.has(id))
      .map((sessionId) => ({ sessionId, reason: this.refuse.get(sessionId)! }))
  })
  rehome = (
    ids: ReadonlyArray<string>,
    target: string,
    options: { layout: WindowLayout | null; focus: boolean }
  ): MoveResult => {
    this.rehomed.push({ sessionIds: [...ids], target, options })
    const { movable, refused } = this.movable(ids)
    return { moved: movable, refused }
  }
  groupMovedAway = (windowKey: string, groupId: string): void => {
    this.movedAway.push({ windowKey, groupId })
  }
}

const group = (
  id: string,
  sessionIds: string[],
  extra: Record<string, unknown> = {}
): SidebarGroup => ({
  id,
  name: id,
  sessionIds,
  collapsed: false,
  cwd: null,
  terminals: [],
  ...extra
})
const terminal = (id: string, sessionId: string | null): GroupTerminal => ({
  id,
  command: 'npm run dev',
  commandMode: 'auto',
  color: 'blue',
  sessionId
})

function setup(documents: Record<string, unknown> = {}): {
  storage: ReturnType<typeof memorySidebarStorage>
  host: FakeHost
  layouts: SidebarLayouts
  events: SidebarEvent[]
} {
  const storage = memorySidebarStorage()
  for (const [key, doc] of Object.entries(documents)) storage.documents.set(key, doc)
  const host = new FakeHost()
  let n = 0
  const layouts = new SidebarLayouts(storage, host, { mintId: () => `m${++n}` })
  const events: SidebarEvent[] = []
  layouts.onChange((event) => events.push(event))
  return { storage, host, layouts, events }
}

describe('loading', () => {
  it('normalises an old-shaped document on first touch, at revision 0', () => {
    const { layouts, events } = setup({
      w1: { groups: [{ id: 'g1', sessionIds: ['a', 7] }, { name: 'no id' }], displayOrder: ['g1'] }
    })
    const snapshot = layouts.get('w1')
    expect(snapshot).toEqual({
      windowKey: 'w1',
      revision: 0,
      groups: [group('g1', ['a'], { name: 'Group' })],
      displayOrder: ['g1']
    })
    expect(events).toEqual([])
  })
  it('answers an empty layout for a window with no document', () => {
    const { layouts } = setup()
    expect(layouts.get('w9')).toEqual({
      windowKey: 'w9',
      revision: 0,
      groups: [],
      displayOrder: []
    })
  })
  it('lists every stored and every cached window', () => {
    const { layouts } = setup({ w1: { groups: [], displayOrder: ['a'] } })
    layouts.get('w2')
    expect(
      layouts
        .list()
        .map((l) => l.windowKey)
        .sort()
    ).toEqual(['w1', 'w2'])
  })
})

describe('orphans', () => {
  const docs = {
    w1: { groups: [group('g1', ['a'])], displayOrder: ['g1'] },
    gone: { groups: [group('g2', ['b'])], displayOrder: ['g2', 'c'] },
    w2: { groups: [], displayOrder: ['d'] }
  }
  it('the primary takes them once, and their documents go', () => {
    const { layouts, host, storage, events } = setup(docs)
    host.known = new Set(['w1', 'w2'])
    host.primary = 'w1'
    const snapshot = layouts.get('w1')
    expect(snapshot.groups.map((g) => g.id)).toEqual(['g1', 'g2'])
    expect(snapshot.displayOrder).toEqual(['g1', 'g2', 'c'])
    expect(snapshot.revision).toBe(1)
    expect(storage.documents.has('gone')).toBe(false)
    expect(storage.documents.has('w2')).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ _tag: 'sidebar.layout_changed', cause: 'orphans' })
    const again = layouts.get('w1')
    expect(again.revision).toBe(1)
    expect(events).toHaveLength(1)
  })
  it('a window that is not primary never takes them', () => {
    const { layouts, host, storage, events } = setup(docs)
    host.known = new Set(['w1', 'w2'])
    host.primary = 'w2'
    expect(layouts.get('w1').groups.map((g) => g.id)).toEqual(['g1'])
    expect(storage.documents.has('gone')).toBe(true)
    expect(events).toEqual([])
  })
})

describe('save', () => {
  it('refuses a stale revision with the current snapshot, writing nothing', () => {
    const { layouts, storage, events } = setup({ w1: { groups: [], displayOrder: ['a'] } })
    layouts.placeSession('w1', 'b', null)
    const before = JSON.stringify(storage.documents.get('w1'))
    const eventsBefore = events.length
    const result = layouts.save('w1', { groups: [], displayOrder: ['z'] }, 0)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error._tag).toBe('LayoutConflict')
    expect(result.error.current).toMatchObject({ revision: 1, displayOrder: ['b', 'a'] })
    expect(JSON.stringify(storage.documents.get('w1'))).toBe(before)
    expect(events.length).toBe(eventsBefore)
  })
  it('writes on the current revision, and without one', () => {
    const { layouts, storage, events } = setup()
    const first = layouts.save('w1', { groups: [], displayOrder: ['a'] }, 0)
    expect(first.ok && first.value.revision).toBe(1)
    const second = layouts.save('w1', { groups: [], displayOrder: ['b'] })
    expect(second.ok && second.value.revision).toBe(2)
    expect(storage.documents.get('w1')).toEqual({ groups: [], displayOrder: ['b'] })
    expect(events.map((e) => e._tag === 'sidebar.layout_changed' && e.cause)).toEqual([
      'save',
      'save'
    ])
  })
  it('an identical save neither writes nor bumps nor tells', () => {
    const { layouts, storage, events } = setup()
    layouts.save('w1', { groups: [], displayOrder: ['a'] })
    const write = vi.spyOn(storage, 'write')
    const again = layouts.save('w1', { groups: [], displayOrder: ['a'] }, 1)
    expect(again.ok && again.value.revision).toBe(1)
    expect(write).not.toHaveBeenCalled()
    expect(events).toHaveLength(1)
  })
})

describe('groups', () => {
  it('createGroup takes the first member’s place and the other members leave the order', () => {
    const { layouts, events } = setup({
      w1: { groups: [group('g0', ['c', 'd'])], displayOrder: ['a', 'g0', 'b', 'e'] }
    })
    const { group: created, layout } = layouts.createGroup('w1', {
      name: 'New',
      sessionIds: ['b', 'e', 'c'],
      color: 'red'
    })
    expect(created).toEqual({ ...group('group-m1', ['b', 'e', 'c']), name: 'New', color: 'red' })
    expect(layout.displayOrder).toEqual(['a', 'g0', 'group-m1'])
    expect(layout.groups.find((g) => g.id === 'g0')!.sessionIds).toEqual(['d'])
    expect(events.at(-1)).toMatchObject({ cause: 'command' })
  })
  it('createGroup with no member in the order is appended, under the id given', () => {
    const { layouts } = setup({ w1: { groups: [], displayOrder: ['a'] } })
    const { layout } = layouts.createGroup('w1', { id: 'mine', name: 'x' })
    expect(layout.displayOrder).toEqual(['a', 'mine'])
  })
  it('the setters set their field, and an unknown group is GroupNotFound', () => {
    const { layouts } = setup({ w1: { groups: [group('g1', [])], displayOrder: ['g1'] } })
    const renamed = layouts.renameGroup('w1', 'g1', '   ')
    expect(renamed.ok && renamed.value.groups[0].name).toBe('Group')
    layouts.renameGroup('w1', 'g1', ' Api ')
    layouts.setGroupColor('w1', 'g1', 'green')
    layouts.setGroupPrompt('w1', 'g1', 'go')
    layouts.setGroupCollapsed('w1', 'g1', true)
    const viewed = layouts.setGroupView('w1', 'g1', { url: 'http://localhost:3000' })
    expect(viewed.ok && viewed.value.groups[0]).toMatchObject({
      name: 'Api',
      color: 'green',
      prompt: 'go',
      collapsed: true,
      view: { url: 'http://localhost:3000' }
    })
    const missing = layouts.renameGroup('w1', 'nope', 'x')
    expect(missing).toEqual({ ok: false, error: { _tag: 'GroupNotFound', groupId: 'nope' } })
    expect(layouts.setGroupView('w1', 'nope', null).ok).toBe(false)
  })
  const withTerminal = {
    w1: {
      groups: [group('g1', ['a', 'b', 't'], { terminals: [terminal('k1', 't')] })],
      displayOrder: ['x', 'g1', 'y', 't']
    }
  }
  it('deleteGroup dissolve puts the members where the group stood, never a terminal', () => {
    const { layouts } = setup(withTerminal)
    const result = layouts.deleteGroup('w1', 'g1', 'dissolve')
    expect(result.ok && result.value).toMatchObject({
      groups: [],
      displayOrder: ['x', 'a', 'b', 'y']
    })
  })
  it('deleteGroup remove drops the group, its members and its terminals’ sessions', () => {
    const { layouts } = setup({
      w1: {
        groups: [group('g1', ['a'], { terminals: [terminal('k1', 't')] })],
        displayOrder: ['x', 'g1', 'a', 't', 'y']
      }
    })
    const result = layouts.deleteGroup('w1', 'g1', 'remove')
    expect(result.ok && result.value.displayOrder).toEqual(['x', 'y'])
    expect(layouts.deleteGroup('w1', 'g1', 'remove').ok).toBe(false)
  })
})

describe('terminals', () => {
  it('adds with a minted id, patches (an explicit null clears), removes', () => {
    const { layouts } = setup({ w1: { groups: [group('g1', [])], displayOrder: ['g1'] } })
    const added = layouts.addTerminal('w1', 'g1', {
      command: 'npm run dev',
      commandMode: 'auto',
      color: 'blue',
      sessionId: 's1'
    })
    expect(added.ok && added.value.terminal).toEqual({ ...terminal('term-m1', 's1') })
    const patched = layouts.updateTerminal('w1', 'g1', 'term-m1', {
      color: 'red',
      sessionId: null
    })
    expect(patched.ok && patched.value.groups[0].terminals[0]).toMatchObject({
      color: 'red',
      sessionId: null,
      command: 'npm run dev'
    })
    expect(layouts.updateTerminal('w1', 'g1', 'nope', {})).toEqual({
      ok: false,
      error: { _tag: 'TerminalNotFound', groupId: 'g1', terminalId: 'nope' }
    })
    expect(layouts.updateTerminal('w1', 'g9', 'x', {}).ok).toBe(false)
    const removed = layouts.removeTerminal('w1', 'g1', 'term-m1')
    expect(removed.ok && removed.value.groups[0].terminals).toEqual([])
    expect(layouts.removeTerminal('w1', 'g1', 'unknown').ok).toBe(true)
    expect(layouts.addTerminal('w1', 'g9', terminal('k', null)).ok).toBe(false)
  })
})

describe('rows', () => {
  it('moveItems applies the shared rule, and a no-op answers unchanged', () => {
    const { layouts, events } = setup({
      w1: { groups: [group('g1', ['a'])], displayOrder: ['g1', 'b'] }
    })
    const moved = layouts.moveItems('w1', ['b'], 'g1', 'inside')
    expect(moved).toMatchObject({ revision: 1, groups: [{ sessionIds: ['a', 'b'] }] })
    const same = layouts.moveItems('w1', ['b'], 'b', 'after')
    expect(same.revision).toBe(1)
    expect(events).toHaveLength(1)
  })
  it('placeSession puts a session first, at the end when asked, and never twice', () => {
    const { layouts } = setup({ w1: { groups: [group('g1', ['a'])], displayOrder: ['g1', 'b'] } })
    expect(layouts.placeSession('w1', 'c', null).displayOrder).toEqual(['c', 'g1', 'b'])
    expect(layouts.placeSession('w1', 'd', 'g1').groups[0].sessionIds).toEqual(['d', 'a'])
    expect(layouts.placeSession('w1', 'e', null, 'end').displayOrder).toEqual(['c', 'g1', 'b', 'e'])
    const before = layouts.get('w1')
    expect(layouts.placeSession('w1', 'a', null)).toEqual(before)
    expect(layouts.placeSession('w1', 'b', 'g1')).toEqual(before)
  })
  it('removeSession takes it out everywhere and detaches a terminal that ran it', () => {
    const { layouts } = setup({
      w1: {
        groups: [group('g1', ['a', 's'], { terminals: [terminal('k1', 's')] })],
        displayOrder: ['g1', 's']
      }
    })
    const after = layouts.removeSession('w1', 's')
    expect(after.displayOrder).toEqual(['g1'])
    expect(after.groups[0].sessionIds).toEqual(['a'])
    expect(after.groups[0].terminals[0].sessionId).toBeNull()
  })
  it('absorb appends unknown groups and entries and leaves known ones', () => {
    const { layouts } = setup({ w1: { groups: [group('g1', ['a'])], displayOrder: ['g1'] } })
    const after = layouts.absorb('w1', {
      groups: [group('g1', ['zz']), group('g2', ['b'])],
      displayOrder: ['g2', 'g1', 'c']
    })
    expect(after.groups.map((g) => [g.id, g.sessionIds])).toEqual([
      ['g1', ['a']],
      ['g2', ['b']]
    ])
    expect(after.displayOrder).toEqual(['g1', 'g2', 'c'])
  })
})

describe('between windows', () => {
  it('moveSessionsToWindow moves what the shell moved, and only that', () => {
    const { layouts, host, events } = setup({
      w1: { groups: [group('g1', ['a'])], displayOrder: ['g1', 'b'] },
      w2: { groups: [], displayOrder: ['z'] }
    })
    host.live = new Set(['w1', 'w2'])
    host.refuse.set('b', 'not-tmux')
    const result = layouts.moveSessionsToWindow(['a', 'b'], 'w2', true)
    expect(result).toEqual({
      ok: true,
      value: { moved: ['a'], refused: [{ sessionId: 'b', reason: 'not-tmux' }] }
    })
    expect(host.rehomed).toEqual([
      { sessionIds: ['a', 'b'], target: 'w2', options: { layout: null, focus: true } }
    ])
    expect(layouts.get('w1')).toMatchObject({
      groups: [{ sessionIds: [] }],
      displayOrder: ['g1', 'b']
    })
    expect(layouts.get('w2').displayOrder).toEqual(['z', 'a'])
    expect(events.map((e) => e._tag === 'sidebar.layout_changed' && e.cause)).toEqual([
      'move',
      'move'
    ])
    expect(layouts.moveSessionsToWindow(['a'], 'w9', false)).toEqual({
      ok: false,
      error: { _tag: 'WindowNotFound', windowKey: 'w9' }
    })
  })
  it('moveGroupToWindow hands the group over and leaves a member that stayed as a row', () => {
    const { layouts, host } = setup({
      w1: {
        groups: [
          group('g1', ['a', 'b'], { terminals: [terminal('k1', 't'), terminal('k2', 'u')] })
        ],
        displayOrder: ['x', 'g1']
      },
      w2: { groups: [], displayOrder: [] }
    })
    host.live = new Set(['w1', 'w2'])
    host.refuse.set('b', 'not-tmux')
    host.refuse.set('u', 'not-live')
    const result = layouts.moveGroupToWindow('w1', 'g1', 'w2')
    expect(result.ok && result.value).toEqual({
      ok: true,
      moved: ['a', 't'],
      refused: [
        { sessionId: 'b', reason: 'not-tmux' },
        { sessionId: 'u', reason: 'not-live' }
      ]
    })
    const handed = group('g1', ['a'], { terminals: [terminal('k1', 't'), terminal('k2', null)] })
    expect(layouts.get('w1')).toMatchObject({ groups: [], displayOrder: ['x', 'b', 'u'] })
    expect(layouts.get('w2')).toMatchObject({ groups: [handed], displayOrder: ['g1'] })
    expect(host.movedAway).toEqual([{ windowKey: 'w1', groupId: 'g1' }])
    expect(host.rehomed).toEqual([
      {
        sessionIds: ['a', 't'],
        target: 'w2',
        options: { layout: { groups: [handed], displayOrder: ['g1'] }, focus: true }
      }
    ])
  })
  it('moveGroupToWindow changes nothing when no linked session can move', () => {
    const { layouts, host, storage, events } = setup({
      w1: { groups: [group('g1', ['a'])], displayOrder: ['g1'] },
      w2: { groups: [], displayOrder: [] }
    })
    host.live = new Set(['w1', 'w2'])
    host.refuse.set('a', 'not-tmux')
    const before = JSON.stringify([...storage.documents])
    const result = layouts.moveGroupToWindow('w1', 'g1', 'w2')
    expect(result).toEqual({
      ok: true,
      value: { ok: false, moved: [], refused: [{ sessionId: 'a', reason: 'not-tmux' }] }
    })
    expect(JSON.stringify([...storage.documents])).toBe(before)
    expect(events).toEqual([])
    expect(host.rehomed).toEqual([])
    expect(host.movedAway).toEqual([])
    expect(layouts.moveGroupToWindow('w1', 'g1', 'w1').ok).toBe(false)
    expect(layouts.moveGroupToWindow('w1', 'nope', 'w2').ok).toBe(false)
  })
  it('windowClosed hands the layout to the primary and removes the document', () => {
    const { layouts, storage, events } = setup({
      w1: { groups: [], displayOrder: ['a'] },
      w2: { groups: [group('g2', ['b'])], displayOrder: ['g2'] }
    })
    const taken = layouts.windowClosed('w2', 'w1')
    expect(taken).toEqual({ groups: [group('g2', ['b'])], displayOrder: ['g2'] })
    expect(storage.documents.has('w2')).toBe(false)
    expect(layouts.get('w1').displayOrder).toEqual(['a', 'g2'])
    expect(events.map((e) => [e._tag, e._tag === 'sidebar.layout_changed' && e.cause])).toEqual([
      ['sidebar.layout_removed', false],
      ['sidebar.layout_changed', 'window-closed']
    ])
  })
})

describe('the cache is the server’s own', () => {
  it('a snapshot handed out cannot change the cache', () => {
    const { layouts } = setup({ w1: { groups: [group('g1', ['a'])], displayOrder: ['g1'] } })
    const snapshot = layouts.get('w1') as unknown as {
      displayOrder: string[]
      groups: Array<{ sessionIds: string[] }>
    }
    try {
      snapshot.displayOrder.push('evil')
    } catch {
      // frozen
    }
    try {
      snapshot.groups[0].sessionIds.push('evil')
    } catch {
      // frozen
    }
    expect(layouts.get('w1')).toMatchObject({
      groups: [{ sessionIds: ['a'] }],
      displayOrder: ['g1']
    })
  })
  it('a throwing listener does not stop the others', () => {
    const { layouts, events } = setup()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    layouts.onChange(() => {
      throw new Error('boom')
    })
    const after: SidebarEvent[] = []
    const off = layouts.onChange((event) => after.push(event))
    layouts.placeSession('w1', 'a', null)
    expect(events).toHaveLength(1)
    expect(after).toHaveLength(1)
    expect(error).toHaveBeenCalledWith('[clave-server] sidebar listener failed', expect.any(Error))
    off()
    layouts.placeSession('w1', 'b', null)
    expect(after).toHaveLength(1)
    error.mockRestore()
  })
})

describe('what the shell may load at boot', () => {
  it('layouts.ts and ports.ts import nothing of Effect, the framework or the contract index', () => {
    for (const file of ['layouts.ts', 'ports.ts']) {
      const text = readFileSync(join(__dirname, file), 'utf8')
      const runtimeImports = [
        ...text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)
      ].map((m) => m[1])
      expect(runtimeImports.length, file).toBeGreaterThan(0)
      for (const source of runtimeImports) {
        expect(source, `${file} imports ${source}`).not.toMatch(
          /^(effect($|\/)|@effect\/|@structure-ai\/|@clave\/contract\/sidebar$)/
        )
      }
    }
  })
})

describe('a server that hosts no windows', () => {
  it('keeps layouts and answers CapabilityUnavailable to a move, changing nothing', () => {
    const storage = memorySidebarStorage()
    const layouts = new SidebarLayouts(storage, noWindowsHost)
    const { group } = layouts.createGroup('w1', { name: 'Kept', sessionIds: ['s1'] })
    const before = JSON.stringify(storage.documents.get('w1'))
    const sessions = layouts.moveSessionsToWindow(['s1'], 'w2', true)
    expect(sessions.ok).toBe(false)
    if (!sessions.ok) expect(sessions.error._tag).toBe('CapabilityUnavailable')
    const whole = layouts.moveGroupToWindow('w1', group.id, 'w2')
    expect(whole.ok).toBe(false)
    if (!whole.ok) expect(whole.error._tag).toBe('CapabilityUnavailable')
    expect(JSON.stringify(storage.documents.get('w1'))).toBe(before)
    expect(layouts.get('w1').groups.map((g) => g.id)).toEqual([group.id])
  })
})
