import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LegacyMigrationRecord } from '../conversations/legacy-migration'
import type { ConversationSnapshot } from '../../shared/agent-session'
import type { LegacyMigrationResult } from '../../shared/session-migration'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  dialog: vi.fn(),
  read: vi.fn(),
  stop: vi.fn(),
  remap: vi.fn(),
  prepare: vi.fn(),
  mappings: vi.fn(),
  snapshot: vi.fn(),
  import: vi.fn(),
  complete: vi.fn(),
  save: vi.fn(),
  load: vi.fn(),
  bind: vi.fn(),
  unbind: vi.fn(),
  owner: vi.fn(),
  restart: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
  close: vi.fn(),
  metadata: vi.fn(),
  records: vi.fn(),
  stamp: vi.fn(),
  kill: vi.fn(),
  setView: vi.fn()
}))
const id = '11111111-1111-1111-1111-111111111111'
const targetId = `conversation-${id}`
const frame = {}
const win = { id: 1, isDestroyed: () => false, once: vi.fn(), webContents: { send: mocks.send } }
const event = { sender: { mainFrame: frame }, senderFrame: frame }
vi.mock('electron', () => ({
  app: { getPath: () => '/mock-profile' },
  BrowserWindow: { fromWebContents: () => win },
  ipcMain: { handle: (channel, handler) => mocks.handlers.set(channel, handler), on: vi.fn() },
  dialog: { showMessageBox: mocks.dialog }
}))
vi.mock('../conversations/runtime', () => ({
  conversationClient: async () => ({
    legacyImportMappings: mocks.mappings,
    snapshot: mocks.snapshot,
    prepareLegacyImport: mocks.import,
    completeLegacyImport: mocks.complete,
    updateMetadata: mocks.metadata
  }),
  disconnectConversationClient: mocks.disconnect,
  isConversationId: (value) => value.startsWith('conversation-'),
  prepareConversation: mocks.prepare,
  closeConversation: mocks.close
}))
vi.mock('../conversations/restart', () => ({ restartConversationService: mocks.restart }))
vi.mock('../pty-manager', () => ({
  ptyManager: {
    readLegacyMigrationRecord: mocks.read,
    stopAndForgetLegacyRecord: mocks.stop,
    remapSessionViewOwner: mocks.remap,
    listAdoptableSessions: mocks.records,
    setSessionWindowKey: mocks.stamp,
    kill: mocks.kill,
    setSessionViewRecord: mocks.setView
  }
}))
vi.mock('../sidebar-layout-manager', () => ({
  sidebarLayoutManager: { loadForWindow: mocks.load, saveForWindow: mocks.save }
}))
vi.mock('../window-registry', () => ({
  windowRegistry: {
    getKeyForWindow: () => 'home',
    getWindowForSession: mocks.owner,
    liveKeys: () => ['home', 'other'],
    isPrimary: () => true,
    bindSession: mocks.bind,
    unbindSession: mocks.unbind,
    listWindows: () => [win]
  }
}))
vi.mock('../window-state', () => ({ windowState: { keys: () => ['home', 'other'] } }))
vi.mock('../linked-documents/runtime', () => ({ linkedDocuments: vi.fn() }))
vi.mock('../mcp/mcp-bridge', () => ({ callRenderer: vi.fn() }))
vi.mock('./clave-file-handlers', () => ({ getPreference: vi.fn() }))
vi.mock('../workspace-manager', () => ({ workspaceManager: {} }))
vi.mock('../title-generator', () => ({ notifyClear: vi.fn() }))
vi.mock('../agent-state-manager', () => ({ startWatching: vi.fn(), clearState: vi.fn() }))
import { registerSessionMigrationHandlers } from './session-migration-handlers'
import { registerPtyHandlers } from './pty-handlers'

let record: LegacyMigrationRecord
let imported: ConversationSnapshot | undefined
const invoke = (operation: string, ...args: unknown[]): Promise<LegacyMigrationResult> =>
  mocks.handlers.get(`session-migration:${operation}`)!(
    event,
    ...args
  ) as Promise<LegacyMigrationResult>

beforeEach(() => {
  vi.clearAllMocks()
  imported = undefined
  record = {
    id,
    recordKey: 'clave-fixture',
    tmuxName: 'clave-fixture',
    cwd: '/fixture',
    folderName: 'fixture',
    windowKey: 'home',
    claudeMode: true,
    codexMode: false,
    piMode: false,
    antigravityMode: false,
    claudeAgentsMode: false,
    dangerousMode: false,
    claudeSessionId: 'native-id',
    claudeProfileId: 'account',
    configDir: '/fixture/account',
    launchProfileId: 'old-profile',
    model: 'model',
    workspaceId: 'workspace',
    view: { url: 'http://localhost:3000' },
    live: true
  }
  mocks.read.mockImplementation(() => record)
  mocks.owner.mockReturnValue(null)
  mocks.dialog.mockResolvedValue({ response: 1 })
  mocks.mappings.mockImplementation(async () => (imported ? { [id]: targetId } : {}))
  mocks.snapshot.mockImplementation(async () => imported)
  mocks.prepare.mockImplementation(async (_win, options) => ({
    options: { ...options, windowKey: 'home' },
    launch: {
      options,
      command: ['fixture'],
      additionalArgs: [],
      env: {},
      sessionDirectory: '/fixture'
    }
  }))
  mocks.import.mockImplementation(async (options, _launch, identity, view) => {
    imported = {
      session: { ...options, id: targetId, legacyImport: identity, view },
      sequence: 0,
      entries: [],
      requests: []
    }
    return imported
  })
  mocks.complete.mockImplementation(async () => {
    imported!.session.legacyImport!.complete = true
    return imported
  })
  mocks.stop.mockResolvedValue(undefined)
  mocks.close.mockResolvedValue(undefined)
  mocks.records.mockImplementation(() => [record])
  mocks.save.mockReturnValue(true)
  mocks.load.mockReturnValue({
    displayOrder: [id],
    groups: [{ id: 'group', sessionIds: [id], terminals: [{ sessionId: id, command: id }] }]
  })
  mocks.restart.mockImplementation(async (options) => {
    if (!(await options.confirm({ openConversations: 2 }))) return false
    await options.disconnect()
    await options.reconnect()
    return true
  })
  registerSessionMigrationHandlers()
  registerPtyHandlers()
})

describe('migration IPC', () => {
  it('inspection and cancellation never prepare, stop, or rewrite records', async () => {
    expect(await invoke('inspect', id)).toMatchObject({ id, resumeSessionId: 'native-id' })
    mocks.dialog.mockResolvedValue({ response: 0 })
    expect(await invoke('migrate', id)).toBeNull()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.stop).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('rejects embedded frames, invalid IDs, and a foreign authoritative record', async () => {
    const embedded = { ...event, senderFrame: {} }
    await expect(mocks.handlers.get('session-migration:migrate')!(embedded, id)).rejects.toThrow(
      'trusted'
    )
    await expect(invoke('inspect', '../../other')).rejects.toThrow('Invalid legacy')
    record.windowKey = 'other'
    mocks.owner.mockReturnValue(win) // A stale runtime binding cannot override the disk record.
    await expect(invoke('migrate', id)).rejects.toThrow('another window')
    expect(mocks.dialog).not.toHaveBeenCalled()
    expect(mocks.stop).not.toHaveBeenCalled()
  })

  it('rechecks ownership after the confirmation dialog', async () => {
    mocks.dialog.mockImplementation(async () => {
      record.windowKey = 'other'
      return { response: 1 }
    })
    await expect(invoke('migrate', id)).rejects.toThrow('another window')
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.stop).not.toHaveBeenCalled()
  })

  it('pins selected options, stops the exact source, remaps layout and hidden owner, and deduplicates', async () => {
    const [first, second] = await Promise.all([
      invoke('migrate', id, 'selected'),
      invoke('migrate', id, 'selected')
    ])
    expect(first).toEqual(second)
    expect(first.snapshot.session.legacyImport?.complete).toBe(true)
    expect(mocks.dialog).toHaveBeenCalledTimes(1)
    expect(mocks.prepare).toHaveBeenCalledWith(
      win,
      expect.objectContaining({
        provider: 'claude',
        launchProfileId: 'selected',
        claudeProfileId: 'account',
        configDir: '/fixture/account',
        model: 'model',
        workspaceId: 'workspace'
      })
    )
    expect(mocks.import.mock.calls[0][0].resumeSessionId).toBe('native-id')
    expect(mocks.stop).toHaveBeenCalledTimes(1)
    expect(mocks.stop).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: id,
        recordKey: 'clave-fixture',
        tmuxName: 'clave-fixture'
      })
    )
    expect(mocks.save).toHaveBeenCalledWith('home', {
      displayOrder: [targetId],
      groups: [
        { id: 'group', sessionIds: [targetId], terminals: [{ sessionId: targetId, command: id }] }
      ]
    })
    expect(mocks.remap).toHaveBeenCalledWith(id, targetId)
    expect(mocks.unbind).toHaveBeenCalledWith(id)
    expect(mocks.bind).toHaveBeenCalledWith(targetId, 1)
    expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.save.mock.invocationCallOrder[0]
    )
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.complete.mock.invocationCallOrder[0]
    )
  })

  it('does not stop on invalid profile; keeps a prepared import retryable after a failed layout save', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('Unknown launch profile'))
    await expect(invoke('migrate', id, 'missing')).rejects.toThrow('Unknown launch profile')
    expect(mocks.stop).not.toHaveBeenCalled()
    mocks.save.mockReturnValueOnce(false)
    await expect(invoke('migrate', id)).rejects.toThrow('persist')
    expect(mocks.complete).not.toHaveBeenCalled()
    expect((await invoke('migrate', id)).snapshot.session.legacyImport?.complete).toBe(true)
    expect(mocks.import).toHaveBeenCalledTimes(1)
  })

  it('uses a prepared target owner after a move and filters mappings', async () => {
    await invoke('migrate', id)
    imported!.session.windowKey = 'other'
    await expect(invoke('inspect', id)).rejects.toThrow('another window')
    expect(await invoke('mappings')).toEqual({})
    imported!.session.windowKey = 'home'
    expect(await invoke('mappings')).toEqual({ [id]: targetId })
  })

  it('rejects closed imports before retry can stop or remap their source again', async () => {
    await invoke('migrate', id)
    imported!.session.status = 'closed'
    imported!.session.legacyImport!.complete = false
    mocks.stop.mockClear()
    mocks.save.mockClear()
    await expect(invoke('migrate', id)).rejects.toThrow('closed')
    expect(mocks.stop).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('requires native restart confirmation and refreshes all windows only after success', async () => {
    mocks.dialog.mockResolvedValueOnce({ response: 0 })
    expect(await invoke('restart-service')).toBe(false)
    expect(mocks.disconnect).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
    expect(await invoke('restart-service')).toBe(true)
    expect(mocks.restart).toHaveBeenCalledWith(
      expect.objectContaining({ userData: '/mock-profile' })
    )
    expect(mocks.disconnect).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledWith('conversation:refresh')
    await expect(
      mocks.handlers.get('session-migration:restart-service')!({
        ...event,
        senderFrame: {}
      })
    ).rejects.toThrow('trusted')
  })

  it('binds metadata-only adoptable agents and stamps orphan homes without spawning', () => {
    record.windowKey = undefined
    const listed = mocks.handlers.get('records:list-adoptable')!(event)
    expect(listed).toEqual([record])
    expect(mocks.stamp).toHaveBeenCalledWith(id, 'home')
    expect(record.windowKey).toBe('home')
    expect(mocks.bind).toHaveBeenCalledWith(id, win.id)
    expect(mocks.stop).not.toHaveBeenCalled()
  })

  it('does not let an ids filter adopt foreign or live-owned records', () => {
    record.windowKey = 'other'
    expect(mocks.handlers.get('records:list-adoptable')!(event, { ids: [id] })).toEqual([])
    record.windowKey = 'home'
    mocks.owner.mockReturnValue({ id: 2 })
    expect(mocks.handlers.get('records:list-adoptable')!(event, { ids: [id] })).toEqual([])
    expect(mocks.bind).not.toHaveBeenCalled()
  })

  it('closes metadata-only legacy agents through exact-record stop, never best-effort kill', async () => {
    await mocks.handlers.get('pty:kill')!(event, id)
    expect(mocks.stop).toHaveBeenCalledWith({
      sourceId: id,
      recordKey: record.recordKey,
      tmuxName: record.tmuxName,
      complete: false
    })
    expect(mocks.kill).not.toHaveBeenCalled()
    expect(mocks.unbind).toHaveBeenCalledWith(id)
  })

  it('routes conversation attached views and close through the service after authorization', async () => {
    await invoke('migrate', id)
    await mocks.handlers.get('session:set-view')!(event, targetId, {
      url: 'http://localhost:3333',
      title: 'Preview',
      extra: 'not persisted'
    })
    expect(mocks.metadata).toHaveBeenCalledWith(targetId, {
      view: { url: 'http://localhost:3333', title: 'Preview' }
    })
    expect(mocks.setView).not.toHaveBeenCalled()
    await mocks.handlers.get('pty:kill')!(event, targetId)
    expect(mocks.close).toHaveBeenCalledWith(targetId)
    imported!.session.windowKey = 'other'
    await expect(mocks.handlers.get('pty:kill')!(event, targetId)).rejects.toThrow('another window')
    expect(mocks.close).toHaveBeenCalledOnce()
  })
})
