import { beforeEach, expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  source: { id: 1, webContents: { send: vi.fn() } },
  target: { id: 2, webContents: { send: vi.fn() } },
  bind: vi.fn(),
  stamp: vi.fn(),
  kill: vi.fn(),
  session: vi.fn(),
  record: vi.fn(),
  snapshot: vi.fn(),
  update: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: {}, BrowserWindow: {} }))
vi.mock('../window-registry', () => ({
  windowRegistry: {
    getWindow: () => fixture.target,
    getWindowForSession: () => fixture.source,
    getKeyForWindow: () => 'target-key',
    bindSession: fixture.bind
  }
}))
vi.mock('../workspace-manager', () => ({ workspaceManager: {} }))
vi.mock('../window-state', () => ({ windowState: {} }))
vi.mock('../sidebar-layout-manager', () => ({ sidebarLayoutManager: {} }))
vi.mock('../pty-manager', () => ({
  ptyManager: {
    getSession: fixture.session,
    readLegacyMigrationRecord: fixture.record,
    setSessionWindowKey: fixture.stamp,
    kill: fixture.kill
  }
}))
vi.mock('../conversations/runtime', () => ({
  isConversationId: (id: string) => id.startsWith('conversation-'),
  conversationClient: async () => ({ snapshot: fixture.snapshot, updateMetadata: fixture.update })
}))
vi.mock('../runtime-plugins/host', () => ({ revokePluginSessionViews: vi.fn() }))
import { moveSessionsToWindow } from './window-handlers'

beforeEach(() => {
  vi.clearAllMocks()
  fixture.session.mockReturnValue(undefined)
  fixture.record.mockReturnValue({ id: 'legacy', claudeMode: true })
  fixture.snapshot.mockResolvedValue({
    session: { status: 'idle', legacyImport: { sourceId: 'legacy', complete: false } }
  })
})

test('moves metadata-only legacy agents without attaching or stopping them', async () => {
  expect(await moveSessionsToWindow(['legacy'], 2)).toEqual({ moved: ['legacy'], refused: [] })
  expect(fixture.stamp).toHaveBeenCalledWith('legacy', 'target-key')
  expect(fixture.bind).toHaveBeenCalledWith('legacy', 2)
  expect(fixture.source.webContents.send).toHaveBeenCalledWith(
    'session:removed-for-rehome',
    'legacy'
  )
  expect(fixture.target.webContents.send).toHaveBeenCalledWith('session:rehome', {
    sessionIds: ['legacy'],
    layout: null,
    focus: true
  })
  expect(fixture.kill).not.toHaveBeenCalled()
})

test('a prepared import moves its remaining source record with the conversation', async () => {
  await moveSessionsToWindow(['conversation-legacy'], 2)
  expect(fixture.update).toHaveBeenCalledWith('conversation-legacy', { windowKey: 'target-key' })
  expect(fixture.stamp).toHaveBeenCalledWith('legacy', 'target-key')
  expect(fixture.kill).not.toHaveBeenCalled()
})

test('unrecorded dead terminals still cannot move', async () => {
  fixture.record.mockReturnValue(undefined)
  expect(await moveSessionsToWindow(['unknown'], 2)).toEqual({
    moved: [],
    refused: [{ sessionId: 'unknown', reason: 'not-live' }]
  })
  expect(fixture.bind).not.toHaveBeenCalled()
})

test.each(['plain-terminal', 'linked-terminal'])(
  'transfers %s ownership before detaching its tmux client',
  async (id) => {
    fixture.session.mockReturnValue({ tmuxName: `clave-${id}` })
    await moveSessionsToWindow([id], 2)
    expect(fixture.stamp).toHaveBeenCalledWith(id, 'target-key')
    expect(fixture.stamp.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.kill.mock.invocationCallOrder[0]
    )
    expect(fixture.kill).toHaveBeenCalledWith(id, false)
    expect(fixture.bind).toHaveBeenCalledWith(id, 2)
  }
)
