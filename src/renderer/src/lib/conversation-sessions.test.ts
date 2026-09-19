import { afterEach, expect, it, vi } from 'vitest'
import type { ConversationSession } from '../../../shared/agent-session'

const store = vi.hoisted(() => ({
  addSessionInGroup: vi.fn(),
  moveItems: vi.fn()
}))
vi.mock('../store/session-store', () => ({ useSessionStore: { getState: () => store } }))
vi.mock('../store/workspace-store', () => ({
  getActiveWorkspaceId: () => 'work',
  getWorkspaceById: () => ({ rootDir: '/workspace' })
}))

import { conversationToSession, duplicateConversation } from './conversation-sessions'

const session: ConversationSession = {
  id: 'conversation-source',
  provider: 'pi',
  cwd: '/workspace',
  title: 'Source',
  status: 'idle',
  createdAt: '',
  updatedAt: '',
  capabilities: { permissions: false, questions: false, resume: true },
  launchProfileId: 'custom-profile',
  model: 'model',
  piProvider: 'provider',
  piThinking: 'high'
}

afterEach(() => vi.unstubAllGlobals())

it('retains Pi profile options when adopting a conversation into renderer state', () => {
  expect(conversationToSession(session)).toMatchObject({
    launchProfileId: 'custom-profile',
    model: 'model',
    piProvider: 'provider',
    piThinking: 'high'
  })
  expect(conversationToSession({ ...session, piThinking: 'invalid' }).piThinking).toBeUndefined()
})

it('duplicates the explicit launch profile and Claude account configuration', async () => {
  const source = {
    ...session,
    provider: 'claude',
    claudeProfileId: 'account',
    configDir: '/isolated/claude-account'
  }
  const create = vi.fn(async (options) => ({ session: { ...source, ...options, id: 'duplicate' } }))
  vi.stubGlobal('window', {
    electronAPI: {
      conversations: { snapshot: async () => ({ session: source }), create }
    }
  })
  await duplicateConversation(source.id)
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: 'claude',
      launchProfileId: 'custom-profile',
      claudeProfileId: 'account',
      configDir: '/isolated/claude-account'
    })
  )
})
