import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resourceKey } from '@clave/contract/fleet'
import type { FleetSnapshot } from '../../../preload/fleet-types'
import type { Session } from './session-types'
let store: typeof import('./session-store')
let fleet: typeof import('./fleet-store')
const spawn = vi.fn()
const memory = new Map<string, string>()
let serial = 0
beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key)
  })
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('electronAPI', {
    spawnSession: spawn,
    killSession: vi.fn(),
    showNotification: async () => {},
    setSessionDisplayName: async () => {}
  })
  store = await import('./session-store')
  fleet = await import('./fleet-store')
})
beforeEach(() => {
  serial++
  spawn.mockClear()
  store.useSessionStore.setState({
    sessions: [],
    groups: [],
    displayOrder: [],
    selectedSessionIds: [],
    focusedSessionId: null,
    fileTabs: []
  })
})
const snapshot = (owner: string, state: 'idle' | 'ended' = 'idle'): FleetSnapshot => {
  const id = resourceKey('session', owner, 'same')
  const groupId = resourceKey('group', owner, 'g')
  return {
    serverId: owner,
    sessions: [
      {
        id,
        provider: 'codex',
        transport: 'events',
        cwd: '/server/repo',
        windowKey: 'other-mac',
        state,
        createdAt: 1,
        adapterId: 'codex',
        title: 'Remote'
      }
    ],
    records: [],
    layout: {
      windowKey: 'server',
      revision: 0,
      groups: [
        {
          id: groupId,
          name: 'Remote',
          cwd: '/server/repo',
          sessionIds: [id],
          terminals: [],
          collapsed: false
        }
      ],
      displayOrder: [groupId]
    }
  }
}
describe('desktop fleet adoption and shared-layout boundaries', () => {
  it('keeps colliding owners visible without spawning stopped records or stealing selection', () => {
    const a = snapshot(`a-${serial}`, 'ended')
    const b = snapshot(`b-${serial}`)
    const local = {
      id: 'same',
      name: 'Local',
      alive: true,
      workspaceId: 'mac-workspace'
    } as Session
    store.useSessionStore.setState({
      sessions: [local],
      selectedSessionIds: ['same'],
      focusedSessionId: 'same'
    })
    fleet.applyFleetSnapshot(a)
    fleet.applyFleetSnapshot(b)
    const state = store.useSessionStore.getState()
    expect(state.sessions.map((s) => s.id)).toEqual(['same', a.sessions[0].id, b.sessions[0].id])
    expect(state.sessions.find((s) => s.id === a.sessions[0].id)).toMatchObject({
      alive: false,
      dormant: false
    })
    expect(state.focusedSessionId).toBe('same')
    expect(spawn).not.toHaveBeenCalled()
    const serverWorkspace = resourceKey('workspace', a.serverId, 'server-ws')
    expect(store.inActiveWorkspace({ workspaceId: serverWorkspace }, 'mac-workspace')).toBe(false)
    expect(store.inActiveWorkspace({ workspaceId: serverWorkspace }, serverWorkspace)).toBe(true)
  })
  it('preserves client collapse and selection when another client renames the shared group', () => {
    const a = snapshot(`a-${serial}`)
    fleet.applyFleetSnapshot(a)
    store.useSessionStore.getState().toggleGroupCollapsed(a.layout.groups[0].id)
    store.useSessionStore.setState({
      focusedSessionId: a.sessions[0].id,
      selectedSessionIds: [a.sessions[0].id]
    })
    const next = {
      ...a,
      layout: {
        ...a.layout,
        revision: 1,
        groups: [{ ...a.layout.groups[0], name: 'Renamed elsewhere' }]
      }
    }
    fleet.applyFleetSnapshot(next)
    const state = store.useSessionStore.getState()
    expect(state.groups[0]).toMatchObject({ name: 'Renamed elsewhere', collapsed: true })
    expect(state.focusedSessionId).toBe(a.sessions[0].id)
  })
  it('preserves remote groups through a local server layout push', () => {
    const a = snapshot(`a-${serial}`)
    fleet.applyFleetSnapshot(a)
    store.setSidebarBase({ windowKey: 'mac', revision: 0, groups: [], displayOrder: [] })
    store.applyServerLayout({ windowKey: 'mac', revision: 1, groups: [], displayOrder: [] })
    expect(store.useSessionStore.getState().groups.map((g) => g.id)).toContain(
      a.layout.groups[0].id
    )
    expect(store.useSessionStore.getState().sessions.map((s) => s.id)).toContain(a.sessions[0].id)
  })
  it('refuses to put two owners in one shared group', () => {
    const a = snapshot(`a-${serial}`)
    const b = snapshot(`b-${serial}`)
    fleet.applyFleetSnapshot(a)
    fleet.applyFleetSnapshot(b)
    const before = store.useSessionStore.getState().groups
    store.useSessionStore.getState().createGroup([a.sessions[0].id, b.sessions[0].id], 'Mixed')
    store.useSessionStore.getState().moveItems([a.sessions[0].id], b.layout.groups[0].id, 'inside')
    expect(store.useSessionStore.getState().groups).toBe(before)
  })
  it('persists owner-tagged metadata for offline startup without request responses', () => {
    const a = snapshot(`a-${serial}`)
    fleet.applyFleetSnapshot(a)
    const saved = JSON.parse(memory.get('clave-fleet-snapshots')!)
    expect(saved[a.serverId].sessions[0].id).toBe(a.sessions[0].id)
    expect(saved[a.serverId]).not.toHaveProperty('requests')
    expect(saved[a.serverId]).not.toHaveProperty('token')
  })
})

it('retains a remote group when its owning server refuses the close', async () => {
  const a = snapshot(`offline-${serial}`)
  fleet.applyFleetSnapshot(a)
  const bridge = window.electronAPI
  const original = bridge.killSession
  bridge.killSession = vi.fn().mockRejectedValue(new Error('disconnected'))
  try {
    const { performGroupDissolve } = await import('../lib/group-dissolve')
    await performGroupDissolve(a.layout.groups[0].id, 'delete')
    expect(store.useSessionStore.getState().groups.map((g) => g.id)).toContain(
      a.layout.groups[0].id
    )
    expect(store.useSessionStore.getState().sessions.map((s) => s.id)).toContain(a.sessions[0].id)
  } finally {
    bridge.killSession = original
  }
})

it('does not bind a directly added remote tab to a Mac workspace', async () => {
  const { useWorkspaceStore } = await import('./workspace-store')
  const previous = useWorkspaceStore.getState().activeWorkspaceId
  useWorkspaceStore.setState({ activeWorkspaceId: 'mac-home' })
  try {
    const id = resourceKey('session', `direct-${serial}`, 'same')
    store.useSessionStore
      .getState()
      .addSession({ id, name: 'Remote', cwd: '/server/repo', alive: true } as Session)
    const tab = store.useSessionStore.getState().sessions.find((s) => s.id === id)!
    expect(tab.workspaceId).toBeUndefined()
    expect(store.inActiveWorkspace(tab, 'another-mac-workspace')).toBe(false)
    expect(
      store.inActiveWorkspace(tab, resourceKey('workspace', `direct-${serial}`, 'any-ws'))
    ).toBe(true)
  } finally {
    useWorkspaceStore.setState({ activeWorkspaceId: previous })
  }
})

it('retains refused remote closes when resetting the desktop sessions', async () => {
  const a = snapshot(`reset-${serial}`)
  fleet.applyFleetSnapshot(a)
  const bridge = window.electronAPI
  const original = bridge.killSession
  bridge.killSession = vi.fn().mockRejectedValue(new Error('disconnected'))
  try {
    await store.useSessionStore.getState().resetSessions()
    expect(store.useSessionStore.getState().sessions.map((s) => s.id)).toContain(a.sessions[0].id)
    expect(store.useSessionStore.getState().groups.map((g) => g.id)).toContain(
      a.layout.groups[0].id
    )
  } finally {
    bridge.killSession = original
  }
})

it('keeps remote file tabs local when another client changes their group', () => {
  const a = snapshot(`file-group-${serial}`)
  fleet.applyFleetSnapshot(a)
  const file = resourceKey('file', a.serverId, '/server/repo/notes.txt')
  store.useSessionStore.getState().addFileTab({ id: file, filePath: file, name: 'notes.txt' })
  store.useSessionStore.setState((state) => ({
    groups: state.groups.map((g) =>
      g.id === a.layout.groups[0].id ? { ...g, sessionIds: [...g.sessionIds, file] } : g
    )
  }))
  fleet.applyFleetSnapshot({
    ...a,
    layout: {
      ...a.layout,
      revision: 1,
      groups: [{ ...a.layout.groups[0], name: 'Renamed remotely' }]
    }
  })
  expect(
    store.useSessionStore.getState().groups.find((g) => g.id === a.layout.groups[0].id)?.sessionIds
  ).toContain(file)
  expect(store.useSessionStore.getState().focusedSessionId).toBe(file)
})

it('does not discard a remote tab that appears while reset closes earlier tabs', async () => {
  const a = snapshot(`reset-race-${serial}`)
  fleet.applyFleetSnapshot(a)
  let finish!: () => void
  const bridge = window.electronAPI
  const original = bridge.killSession
  bridge.killSession = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  try {
    const pending = store.useSessionStore.getState().resetSessions()
    const id = resourceKey('session', a.serverId, 'new-from-other-client')
    store.useSessionStore.getState().addSession({ id, name: 'New', alive: true } as Session)
    finish()
    await pending
    expect(store.useSessionStore.getState().sessions.map((s) => s.id)).toContain(id)
  } finally {
    bridge.killSession = original
  }
})

describe('inActiveWorkspace scopes remote tabs to their server workspace', () => {
  const serverWs = (server: string, id: string): string => resourceKey('workspace', server, id)
  const remoteTab = (
    server: string,
    workspaceId?: string
  ): { id: string; workspaceId?: string } => ({
    id: resourceKey('session', server, 'tab'),
    workspaceId
  })

  it('shows everything when no workspace is active', () => {
    expect(store.inActiveWorkspace(remoteTab('srv', serverWs('srv', 'ws')), null)).toBe(true)
    expect(store.inActiveWorkspace({ id: 'local', workspaceId: 'mac-ws' }, null)).toBe(true)
  })

  it('matches a stamped item to its own workspace only, local or server', () => {
    const ws = serverWs('srv', 'ws')
    expect(store.inActiveWorkspace(remoteTab('srv', ws), ws)).toBe(true)
    expect(store.inActiveWorkspace(remoteTab('srv', ws), serverWs('srv', 'other'))).toBe(false)
    expect(store.inActiveWorkspace(remoteTab('srv', ws), 'mac-ws')).toBe(false)
    expect(store.inActiveWorkspace({ id: 'local', workspaceId: 'mac-ws' }, 'mac-ws')).toBe(true)
    expect(store.inActiveWorkspace({ id: 'local', workspaceId: 'mac-ws' }, ws)).toBe(false)
  })

  it('shows an unstamped remote tab in any workspace of its own server and nowhere else', () => {
    expect(store.inActiveWorkspace(remoteTab('srv'), serverWs('srv', 'ws'))).toBe(true)
    expect(store.inActiveWorkspace(remoteTab('srv'), serverWs('other-srv', 'ws'))).toBe(false)
    expect(store.inActiveWorkspace(remoteTab('srv'), 'mac-ws')).toBe(false)
  })

  it('keeps the safety net for an unstamped local item', () => {
    expect(store.inActiveWorkspace({ id: 'local' }, 'mac-ws')).toBe(true)
    expect(store.inActiveWorkspace({ id: 'local', workspaceId: null }, serverWs('srv', 'ws'))).toBe(
      true
    )
  })
})

describe('the servers’ versions (issue #266)', () => {
  it('keeps the last decision per server, and drops a server main left out', () => {
    const base = { appVersion: '3.0.0-beta.9', automatic: true } as const
    fleet.applyServerVersions([
      { serverId: 'a', kind: 'match', serverVersion: '3.0.0-beta.9', ...base },
      {
        serverId: 'b',
        kind: 'manual',
        command: 'bash ~/install-server.sh --ref v3.0.0-beta.9',
        ...base
      }
    ])
    expect(Object.keys(fleet.useFleetStore.getState().versions)).toEqual(['a', 'b'])
    fleet.applyServerVersions([{ serverId: 'a', kind: 'upgrading', target: '3.0.1', ...base }])
    expect(fleet.useFleetStore.getState().versions).toEqual({
      a: { serverId: 'a', kind: 'upgrading', target: '3.0.1', ...base }
    })
  })
})

describe('a snapshot catches up on what happened while the desktop was away (PRDCT-4668)', () => {
  type WireState = FleetSnapshot['sessions'][number]['state']
  const at = (owner: string, state: WireState): FleetSnapshot => {
    const base = snapshot(owner)
    return { ...base, sessions: [{ ...base.sessions[0], state }] }
  }
  const tab = (owner: string): Session =>
    store.useSessionStore
      .getState()
      .sessions.find((s) => s.id === resourceKey('session', owner, 'same'))!

  it('marks unread a known tab that went from working to done, out of view', () => {
    const owner = `away-${serial}`
    fleet.applyFleetSnapshot(at(owner, 'working'))
    expect(tab(owner)).toMatchObject({ agentState: 'working', hasUnseenActivity: false })
    fleet.applyFleetSnapshot(at(owner, 'done'))
    expect(tab(owner)).toMatchObject({ agentState: 'done', hasUnseenActivity: true })
  })

  it('does not mark the tab in view', () => {
    const owner = `seen-${serial}`
    fleet.applyFleetSnapshot(at(owner, 'working'))
    store.useSessionStore.setState({ selectedSessionIds: [resourceKey('session', owner, 'same')] })
    fleet.applyFleetSnapshot(at(owner, 'done'))
    expect(tab(owner)).toMatchObject({ agentState: 'done', hasUnseenActivity: false })
  })

  it('leaves the mark as it was when the state did not change', () => {
    const owner = `same-${serial}`
    const id = resourceKey('session', owner, 'same')
    fleet.applyFleetSnapshot(at(owner, 'done'))
    expect(tab(owner).hasUnseenActivity).toBe(false)
    fleet.applyFleetSnapshot(at(owner, 'done'))
    expect(tab(owner).hasUnseenActivity).toBe(false)
    store.useSessionStore.setState((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, hasUnseenActivity: true } : s))
    }))
    fleet.applyFleetSnapshot(at(owner, 'done'))
    expect(tab(owner).hasUnseenActivity).toBe(true)
  })

  it('a first sight of a session at rest is not news', () => {
    const owner = `first-${serial}`
    fleet.applyFleetSnapshot(at(owner, 'done'))
    expect(tab(owner).hasUnseenActivity).toBe(false)
  })

  it('keeps the prompt this desktop derived from the stream', () => {
    const owner = `prompt-${serial}`
    const id = resourceKey('session', owner, 'same')
    fleet.applyFleetSnapshot(at(owner, 'blocked'))
    store.useSessionStore.setState((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, promptWaiting: 'Allow?' } : s))
    }))
    fleet.applyFleetSnapshot(at(owner, 'blocked'))
    expect(tab(owner).promptWaiting).toBe('Allow?')
  })

  it('a cached snapshot lists the sessions with no agent state, and a live one sets it', () => {
    const owner = `cached-${serial}`
    fleet.applyFleetSnapshot(at(owner, 'working'), { cached: true })
    expect(tab(owner)).toMatchObject({ agentState: undefined, hasUnseenActivity: false })
    fleet.applyFleetSnapshot(at(owner, 'working'))
    expect(tab(owner)).toMatchObject({ agentState: 'working', hasUnseenActivity: false })
  })

  it('a turn that ended while the app was quit is marked unread at the first live snapshot', () => {
    const owner = `quit-working-${serial}`
    fleet.applyFleetSnapshot(at(owner, 'working'), { cached: true })
    expect(tab(owner).agentState).toBeUndefined()
    fleet.applyFleetSnapshot(at(owner, 'done'))
    expect(tab(owner)).toMatchObject({ agentState: 'done', hasUnseenActivity: true })
  })

  it('a tab the cache already knew at rest gets no mark', () => {
    const owner = `quit-done-${serial}`
    fleet.applyFleetSnapshot(at(owner, 'done'), { cached: true })
    fleet.applyFleetSnapshot(at(owner, 'done'))
    expect(tab(owner)).toMatchObject({ agentState: 'done', hasUnseenActivity: false })
  })

  it('the cached state is the base of the first live snapshot only', () => {
    const owner = `quit-once-${serial}`
    const id = resourceKey('session', owner, 'same')
    fleet.applyFleetSnapshot(at(owner, 'working'), { cached: true })
    // The first live snapshot says the session has no state to tell (ended).
    fleet.applyFleetSnapshot(at(owner, 'ended'))
    expect(tab(owner)).toMatchObject({ agentState: undefined, hasUnseenActivity: false })
    // The second compares with the live state, not the cache's `working`.
    fleet.applyFleetSnapshot(at(owner, 'done'))
    expect(tab(owner)).toMatchObject({ agentState: 'done', hasUnseenActivity: false })
    expect(id).toBe(tab(owner).id)
  })

  it('a cached snapshot is not written back over the stored one', () => {
    const owner = `cached-store-${serial}`
    fleet.applyFleetSnapshot(at(owner, 'working'), { cached: true })
    const saved = JSON.parse(memory.get('clave-fleet-snapshots') ?? '{}')
    expect(saved[owner]).toBeUndefined()
  })
})

describe('who opened a server tab, named as this window names it (PRDCT-4193)', () => {
  // The reach rule compares keys: a server record names its opener by the raw
  // id of its own store, so the window must wrap it in that server's key, or
  // a tab opened by an agent on the server would never reach its opener.
  const withRecord = (owner: string, extra: Record<string, unknown>): FleetSnapshot => {
    const base = snapshot(owner)
    return {
      ...base,
      records: [
        {
          id: base.sessions[0].id,
          cwd: '/server/repo',
          folderName: 'repo',
          running: true,
          ...extra
        } as unknown as FleetSnapshot['records'][number]
      ]
    }
  }
  it('maps the record’s openedBy and spawnedBy raw ids to keys of that server', () => {
    const owner = `s-${serial}`
    const a = withRecord(owner, { openedBy: 'opener-raw', spawnedBy: 'nester-raw' })
    fleet.applyFleetSnapshot(a)
    const session = store.useSessionStore.getState().sessions.find((s) => s.id === a.sessions[0].id)
    expect(session?.openedBy).toBe(resourceKey('session', owner, 'opener-raw'))
    expect(session?.spawnedBy).toBe(resourceKey('session', owner, 'nester-raw'))
  })
  it('leaves both undefined when the record names nobody', () => {
    const a = withRecord(`s-${serial}`, {})
    fleet.applyFleetSnapshot(a)
    const session = store.useSessionStore.getState().sessions.find((s) => s.id === a.sessions[0].id)
    expect(session?.openedBy).toBeUndefined()
    expect(session?.spawnedBy).toBeUndefined()
  })
  // PRDCT-4997. A snapshot reaches the store through the preload, which scopes
  // a record's `spawnedBy` to a key first (`scopeRecord`): the shape below is
  // the one the app delivers. Keyed a second time it named no tab, and a
  // server's nested tabs were never folded on a desktop.
  it('takes a link the preload already scoped as it is, never keyed twice', () => {
    const owner = `s-${serial}`
    const nester = resourceKey('session', owner, 'nester-raw')
    const a = withRecord(owner, { openedBy: 'opener-raw', spawnedBy: nester })
    fleet.applyFleetSnapshot(a)
    const session = store.useSessionStore.getState().sessions.find((s) => s.id === a.sessions[0].id)
    expect(session?.spawnedBy).toBe(nester)
    expect(session?.openedBy).toBe(resourceKey('session', owner, 'opener-raw'))
    // Applied again (every `session.*` event re-reads the server): the same.
    fleet.applyFleetSnapshot(a)
    expect(
      store.useSessionStore.getState().sessions.find((s) => s.id === a.sessions[0].id)?.spawnedBy
    ).toBe(nester)
  })
  it('names a tab of the snapshot itself, so the sidebar can fold under it', () => {
    const owner = `s-${serial}`
    const base = withRecord(owner, {})
    const parentId = base.sessions[0].id
    const childId = resourceKey('session', owner, 'child-raw')
    const a = {
      ...base,
      sessions: [...base.sessions, { ...base.sessions[0], id: childId }],
      records: [
        ...base.records,
        // As the preload delivers it: the child's link is its parent's key.
        { ...base.records[0], id: childId, spawnedBy: parentId }
      ]
    } as typeof base
    fleet.applyFleetSnapshot(a)
    const sessions = store.useSessionStore.getState().sessions
    const child = sessions.find((s) => s.id === childId)
    expect(child?.spawnedBy).toBe(parentId)
    expect(sessions.some((s) => s.id === child?.spawnedBy)).toBe(true)
  })
})
