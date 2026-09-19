import { beforeEach, expect, it, vi } from 'vitest'

const adoptSessionInPlace = vi.hoisted(() => vi.fn())
vi.mock('../store/session-store', () => ({
  useSessionStore: {
    setState: vi.fn(),
    getState: () => ({ sessions: [], groups: [], adoptSessionInPlace })
  }
}))
import { adoptRehomed, retryPendingRehomes } from './adopt-record'

beforeEach(() => vi.clearAllMocks())

it('adopts a mapped source and target once and acknowledges the original request', async () => {
  const snapshot = vi.fn().mockResolvedValue({
    session: {
      id: 'conversation-target',
      provider: 'claude',
      cwd: '/project',
      status: 'idle'
    }
  })
  const listSessionRecords = vi.fn()
  const ackRehomed = vi.fn()
  vi.stubGlobal('window', {
    electronAPI: {
      sessionMigration: { mappings: async () => ({ source: 'conversation-target' }) },
      conversations: { snapshot },
      listSessionRecords,
      ackRehomed
    }
  })
  await adoptRehomed(['source', 'conversation-target'], null, true)
  expect(snapshot).toHaveBeenCalledExactlyOnceWith('conversation-target')
  expect(adoptSessionInPlace).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: 'conversation-target' }),
    { focus: true }
  )
  expect(listSessionRecords).not.toHaveBeenCalled()
  expect(ackRehomed).toHaveBeenCalledWith(['source', 'conversation-target'])
})

it('rehomes an ordinary terminal while conversation discovery is unavailable', async () => {
  const spawnSession = vi.fn().mockResolvedValue({ id: 'terminal', cwd: '/project', alive: true })
  const ackRehomed = vi.fn()
  vi.stubGlobal('window', {
    electronAPI: {
      sessionMigration: {
        mappings: async () => {
          throw new Error('older service')
        }
      },
      listSessionRecords: async () => [{ id: 'terminal', cwd: '/project', claudeMode: false }],
      spawnSession,
      ackRehomed
    }
  })
  await adoptRehomed(['terminal'], null, true)
  expect(spawnSession).toHaveBeenCalledOnce()
  expect(adoptSessionInPlace).toHaveBeenCalledWith(expect.objectContaining({ id: 'terminal' }), {
    focus: true
  })
  expect(ackRehomed).toHaveBeenCalledWith(['terminal'])
})

it('retains a conversation rehome until a successful service recovery', async () => {
  const snapshot = vi.fn().mockRejectedValue(new Error('service unavailable'))
  const ackRehomed = vi.fn()
  vi.stubGlobal('window', {
    electronAPI: {
      sessionMigration: { mappings: async () => ({}) },
      conversations: { snapshot },
      ackRehomed
    }
  })
  await adoptRehomed(['conversation-pending'], null, true)
  expect(ackRehomed).not.toHaveBeenCalled()
  snapshot.mockResolvedValue({
    session: {
      id: 'conversation-pending',
      provider: 'claude',
      cwd: '/project',
      status: 'idle'
    }
  })
  await retryPendingRehomes()
  expect(adoptSessionInPlace).toHaveBeenCalledOnce()
  expect(ackRehomed).toHaveBeenCalledWith(['conversation-pending'])
  await retryPendingRehomes()
  expect(adoptSessionInPlace).toHaveBeenCalledOnce()
})
