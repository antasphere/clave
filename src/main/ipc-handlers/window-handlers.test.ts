import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const mocks = vi.hoisted(() => {
  const workspace = { id: 'server-only', name: 'New workspace' }
  const localState = { workspaces: [], lastActiveWorkspaceId: null }
  const remoteState = { workspaces: [workspace], lastActiveWorkspaceId: workspace.id }
  return {
    attached: true,
    endpoint: true,
    handlers: new Map<string, Handler>(),
    win: { id: 1, isDestroyed: () => false },
    localLoad: vi.fn(() => localState),
    remoteLoad: vi.fn(async () => remoteState),
    localLastActive: vi.fn(),
    remoteLastActive: vi.fn(async () => {}),
    setWindowWorkspace: vi.fn(),
    getWorkspaceForWindow: vi.fn(() => 'server-only' as string | null),
    upsert: vi.fn(),
    openWindow: vi.fn(async () => ({ windowId: 2 }))
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: Handler) => mocks.handlers.set(name, handler),
    on: vi.fn()
  },
  BrowserWindow: { fromWebContents: () => mocks.win }
}))
vi.mock('../workspace-manager', () => ({
  workspaceManager: { load: mocks.localLoad, setLastActive: mocks.localLastActive }
}))
vi.mock('../server/endpoint', () => ({
  isServerExternal: () => mocks.attached,
  getClaveServerEndpoint: () => (mocks.endpoint ? {} : null)
}))
vi.mock('../mcp/server-client', () => ({
  serverClient: {
    api: async () => ({
      settings: { workspaces: { load: mocks.remoteLoad, setLastActive: mocks.remoteLastActive } }
    })
  }
}))
vi.mock('../window-registry', () => ({
  windowRegistry: {
    setWindowWorkspace: mocks.setWindowWorkspace,
    getKeyForWindow: () => 'window-one',
    getWorkspaceForWindow: mocks.getWorkspaceForWindow,
    identityOf: (): { workspaceId: string | null } => ({
      workspaceId: mocks.getWorkspaceForWindow()
    })
  }
}))
vi.mock('../window-state', () => ({ windowState: { upsert: mocks.upsert } }))
vi.mock('../rehome-ack', () => ({ rehomeAck: {} }))
vi.mock('../sidebar-layouts', () => ({
  rehomeSessions: vi.fn(),
  sidebarLayouts: vi.fn(),
  isAttachedServer: () => mocks.attached,
  withAttachedRelease: vi.fn(),
  groupLinkedSessionIds: vi.fn(),
  sessionIdsInWindow: vi.fn()
}))

import { registerWindowHandlers } from './window-handlers'

const invoke = (name: string, id?: string): unknown => mocks.handlers.get(name)!({ sender: {} }, id)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.attached = true
  mocks.endpoint = true
  mocks.getWorkspaceForWindow.mockReturnValue('server-only')
  registerWindowHandlers({ openWindow: mocks.openWindow })
})

describe('runtime workspace selection', () => {
  it('accepts server-only workspaces and persists last-active on their server', async () => {
    expect(await invoke('window:set-workspace', 'server-only')).toEqual({ ok: true })
    expect(mocks.remoteLastActive).toHaveBeenCalledWith('server-only')
    expect(mocks.setWindowWorkspace).toHaveBeenCalledWith(1, 'server-only')
    expect(mocks.upsert).toHaveBeenCalledWith('window-one', { workspaceId: 'server-only' })
    expect(mocks.localLoad).not.toHaveBeenCalled()
    expect(mocks.localLastActive).not.toHaveBeenCalled()
  })

  it('refuses a workspace missing from the authoritative registry', async () => {
    expect(await invoke('window:set-workspace', 'unknown')).toEqual({
      ok: false,
      reason: 'unknown-workspace'
    })
    expect(mocks.remoteLastActive).not.toHaveBeenCalled()
    expect(mocks.setWindowWorkspace).not.toHaveBeenCalled()
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('propagates a registry failure without changing the window or using local state', async () => {
    mocks.remoteLoad.mockRejectedValueOnce(new Error('server unavailable'))
    await expect(invoke('window:set-workspace', 'server-only')).rejects.toThrow(
      'server unavailable'
    )
    expect(mocks.localLoad).not.toHaveBeenCalled()
    expect(mocks.setWindowWorkspace).not.toHaveBeenCalled()
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('leaves the window unchanged when saving last-active fails', async () => {
    mocks.remoteLastActive.mockRejectedValueOnce(new Error('write failed'))
    await expect(invoke('window:set-workspace', 'server-only')).rejects.toThrow('write failed')
    expect(mocks.setWindowWorkspace).not.toHaveBeenCalled()
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('uses the local registry and persistence in process', async () => {
    mocks.attached = false
    mocks.localLoad.mockReturnValueOnce({
      workspaces: [{ id: 'local' }],
      lastActiveWorkspaceId: 'local'
    } as never)
    expect(await invoke('window:set-workspace', 'local')).toEqual({ ok: true })
    expect(mocks.localLastActive).toHaveBeenCalledWith('local')
    expect(mocks.remoteLoad).not.toHaveBeenCalled()
    expect(mocks.remoteLastActive).not.toHaveBeenCalled()
  })
})

describe('runtime window opening', () => {
  it('opens a workspace registered only on the server', async () => {
    expect(await invoke('window:open', 'server-only')).toEqual({ windowId: 2 })
    expect(mocks.openWindow).toHaveBeenCalledWith('server-only')
  })

  it('uses the server last-active default when the window has no workspace', async () => {
    mocks.getWorkspaceForWindow.mockReturnValue(null)
    await invoke('window:open')
    expect(mocks.openWindow).toHaveBeenCalledWith('server-only')
  })

  it('does not open an unregistered workspace', async () => {
    await expect(invoke('window:open', 'unknown')).rejects.toThrow('No registered workspace')
    expect(mocks.openWindow).not.toHaveBeenCalled()
  })

  it('does not open a window when the server registry cannot be loaded', async () => {
    mocks.remoteLoad.mockRejectedValueOnce(new Error('server unavailable'))
    await expect(invoke('window:open', 'server-only')).rejects.toThrow('server unavailable')
    expect(mocks.openWindow).not.toHaveBeenCalled()
    expect(mocks.localLoad).not.toHaveBeenCalled()
  })
})

describe('restored window identity', () => {
  it('returns the saved identity immediately while an external server boots', async () => {
    mocks.endpoint = false
    expect(await invoke('window:identity')).toEqual({ workspaceId: 'server-only' })
    expect(mocks.remoteLoad).not.toHaveBeenCalled()
    expect(mocks.localLoad).not.toHaveBeenCalled()
    mocks.endpoint = true
    await invoke('window:identity')
    expect(mocks.remoteLoad).toHaveBeenCalledOnce()
  })
  it('keeps a saved server-only workspace and resolves it only once', async () => {
    expect(await invoke('window:identity')).toEqual({ workspaceId: 'server-only' })
    await invoke('window:identity')
    expect(mocks.remoteLoad).toHaveBeenCalledOnce()
    expect(mocks.setWindowWorkspace).not.toHaveBeenCalled()
    expect(mocks.localLoad).not.toHaveBeenCalled()
  })

  it('replaces a removed saved workspace with the server default', async () => {
    mocks.getWorkspaceForWindow.mockReturnValue('removed')
    await invoke('window:identity')
    expect(mocks.setWindowWorkspace).toHaveBeenCalledWith(1, 'server-only')
    expect(mocks.upsert).toHaveBeenCalledWith('window-one', { workspaceId: 'server-only' })
  })

  it('propagates a failed external boot instead of using the shell registry', async () => {
    mocks.remoteLoad.mockRejectedValueOnce(new Error('server failed to start'))
    await expect(invoke('window:identity')).rejects.toThrow('server failed to start')
    expect(mocks.localLoad).not.toHaveBeenCalled()
    expect(mocks.setWindowWorkspace).not.toHaveBeenCalled()
  })
})
