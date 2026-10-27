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
