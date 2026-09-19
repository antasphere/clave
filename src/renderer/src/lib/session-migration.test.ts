import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../store/session-types'

vi.mock('../store/session-store', () => ({
  useSessionStore: { setState: vi.fn(), getState: () => ({ adoptSessionInPlace: vi.fn() }) }
}))
import {
  deferConversationRecovery,
  refreshMigratedConversations,
  remapMigrationState,
  restartConversationService
} from './session-migration'

function fixture(): Parameters<typeof remapMigrationState>[0] {
  return {
    sessions: [
      { id: 'old', legacyAgentId: 'old' },
      { id: 'conversation-new', name: 'restored' },
      { id: 'child', spawnedBy: 'old', view: { serverSessionId: 'old' } }
    ] as Session[],
    groups: [
      { id: 'group', sessionIds: ['old', 'conversation-new'], terminals: [{ sessionId: 'old' }] }
    ],
    displayOrder: ['group', 'old', 'conversation-new'],
    focusedSessionId: 'old',
    activeSessionViewId: 'old',
    selectedSessionIds: ['old', 'conversation-new'],
    workspaceSelections: {
      workspace: { focusedSessionId: 'old', selectedSessionIds: ['old', 'conversation-new'] }
    },
    sidebarUndoStack: [{ old: true }]
  }
}

describe('migration identity remapping', () => {
  it('deduplicates targets and moves every layout, selection and owner reference', () => {
    const state = fixture()
    const next = remapMigrationState(state, { old: 'conversation-new' })
    expect(next.sessions.map((session) => session.id)).toEqual(['conversation-new', 'child'])
    expect(next.sessions[0].name).toBe('restored')
    expect(next.sessions[1]).toMatchObject({
      spawnedBy: 'conversation-new',
      view: { serverSessionId: 'conversation-new' }
    })
    expect(next.groups[0]).toMatchObject({
      sessionIds: ['conversation-new'],
      terminals: [{ sessionId: 'conversation-new' }]
    })
    expect(next.displayOrder).toEqual(['group', 'conversation-new'])
    expect(next.focusedSessionId).toBe('conversation-new')
    expect(next.activeSessionViewId).toBe('conversation-new')
    expect(next.selectedSessionIds).toEqual(['conversation-new'])
    expect(next.workspaceSelections.workspace).toEqual({
      focusedSessionId: 'conversation-new',
      selectedSessionIds: ['conversation-new']
    })
    expect(next.sidebarUndoStack).toEqual([])
    expect(state.sessions[0].id).toBe('old')
  })

  it('is referentially stable without relevant mappings', () => {
    const state = fixture()
    expect(remapMigrationState(state, {})).toBe(state)
  })
})

describe('service recovery', () => {
  const list = vi.fn()
  const restart = vi.fn()
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      electronAPI: {
        sessionMigration: { mappings: async () => ({}), restartService: restart },
        conversations: { list }
      }
    })
  })

  it('keeps persistence deferred through failed reads and finishes after a successful refresh', async () => {
    const finish = vi.fn()
    deferConversationRecovery(finish)
    list.mockRejectedValueOnce(new Error('incompatible service'))
    await expect(refreshMigratedConversations()).rejects.toThrow('incompatible service')
    expect(finish).not.toHaveBeenCalled()
    restart.mockResolvedValueOnce(false)
    expect(await restartConversationService()).toBe(false)
    expect(finish).not.toHaveBeenCalled()
    restart.mockResolvedValueOnce(true)
    list.mockResolvedValue([])
    expect(await restartConversationService()).toBe(true)
    expect(finish).toHaveBeenCalledOnce()
    await refreshMigratedConversations()
    expect(finish).toHaveBeenCalledOnce()
  })
})
