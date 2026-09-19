import { beforeEach, expect, test, vi } from 'vitest'
import type { PtySpawnOptions } from '../pty-manager'

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, unknown>(),
  schedule: vi.fn(),
  spawn: vi.fn(() => ({
    id: 'old-tab',
    cwd: '/project',
    folderName: 'project',
    alive: true,
    claudeSessionId: 'old-conversation'
  }))
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, callback: unknown) => fixture.handlers.set(channel, callback),
    on: vi.fn()
  },
  BrowserWindow: {
    fromWebContents: () => ({ id: 1 }),
    getAllWindows: () => []
  }
}))
vi.mock('../pty-manager', () => ({
  ptyManager: { spawn: fixture.spawn, attachListeners: vi.fn() },
  isTmuxAvailable: vi.fn(),
  scrollTmuxSessionToText: vi.fn()
}))
vi.mock('../linked-documents/runtime', () => ({ linkedDocuments: vi.fn() }))
vi.mock('../mcp/mcp-bridge', () => ({ callRenderer: vi.fn() }))
vi.mock('./clave-file-handlers', () => ({ getPreference: () => false }))
vi.mock('../workspace-manager', () => ({
  workspaceManager: { getLastActiveWorkspaceId: () => 'workspace' }
}))
vi.mock('../window-state', () => ({ windowState: {} }))
vi.mock('../sidebar-layout-manager', () => ({ sidebarLayoutManager: {} }))
vi.mock('../window-registry', () => ({
  windowRegistry: {
    getWorkspaceForWindow: () => 'workspace',
    getKeyForWindow: () => 'window',
    bindSession: vi.fn()
  }
}))
vi.mock('../conversations/runtime', () => ({
  closeConversation: vi.fn(),
  conversationClient: vi.fn(),
  isConversationId: vi.fn(),
  spawnConversation: vi.fn()
}))
vi.mock('../agent-state-manager', () => ({ startWatching: vi.fn(), clearState: vi.fn() }))
vi.mock('../title-generator', () => ({
  scheduleTitleGeneration: fixture.schedule,
  cleanup: vi.fn(),
  notifyClear: vi.fn()
}))

import { registerPtyHandlers } from './pty-handlers'

beforeEach(() => {
  vi.clearAllMocks()
  fixture.handlers.clear()
  registerPtyHandlers()
})

test.each([
  { adoptSessionId: 'old-tab' },
  { adoptTmuxName: 'clave-old-agent' },
  { adoptSessionId: 'old-tab', resumeSessionId: 'old-conversation' }
])('restoring %j does not retitle the old conversation', async (options) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const spawn = fixture.handlers.get('pty:spawn') as (
      event: { sender: object },
      cwd: string,
      options: PtySpawnOptions
    ) => Promise<unknown>
    await spawn({ sender: {} }, '/project', options)
    expect(fixture.spawn).toHaveBeenCalledWith('/project', expect.objectContaining(options))
    expect(fixture.schedule).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('(restored)'))
  } finally {
    log.mockRestore()
  }
})
