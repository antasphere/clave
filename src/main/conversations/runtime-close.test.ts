import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  close: vi.fn(),
  snapshot: vi.fn(),
  unbind: vi.fn(),
  revoke: vi.fn(),
  removeConfig: vi.fn()
}))
vi.mock('electron', () => ({ app: { getPath: () => '/mock-only' } }))
vi.mock('./client', () => ({
  ConversationClient: {
    connect: async () => ({
      onEvent: vi.fn(),
      isConnected: () => true,
      snapshot: mocks.snapshot,
      close: mocks.close
    })
  }
}))
vi.mock('../pty-manager', () => ({
  ptyManager: { stopAndForgetLegacyRecord: mocks.stop }
}))
vi.mock('../launch-profile-manager', () => ({ launchProfileManager: {} }))
vi.mock('../mcp/mcp-runtime', () => ({ deleteSessionMcpConfig: mocks.removeConfig }))
vi.mock('../window-registry', () => ({ windowRegistry: { unbindSession: mocks.unbind } }))
vi.mock('../window-state', () => ({ windowState: {} }))
vi.mock('../ipc-handlers/clave-file-handlers', () => ({}))
vi.mock('../runtime-plugins/registry-runtime', () => ({}))
vi.mock('../runtime-plugins/host', () => ({ revokePluginSessionViews: mocks.revoke }))
import { closeConversation } from './runtime'

const id = 'conversation-11111111-1111-1111-1111-111111111111'
const identity = {
  sourceId: '11111111-1111-1111-1111-111111111111',
  recordKey: 'clave-test',
  tmuxName: 'clave-test',
  complete: false
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.snapshot.mockResolvedValue({ session: { id, legacyImport: identity } })
  mocks.stop.mockResolvedValue(undefined)
})

it('stops a prepared legacy source before closing its conversation or revoking views', async () => {
  await closeConversation(id)
  expect(mocks.stop).toHaveBeenCalledWith(identity)
  expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.close.mock.invocationCallOrder[0]
  )
  expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.revoke.mock.invocationCallOrder[0]
  )
  expect(mocks.unbind).toHaveBeenCalledWith(identity.sourceId)
  expect(mocks.unbind).toHaveBeenCalledWith(id)
})

it('leaves the prepared conversation open when stopping the old source fails', async () => {
  mocks.stop.mockRejectedValue(new Error('Still running'))
  await expect(closeConversation(id)).rejects.toThrow('Still running')
  expect(mocks.close).not.toHaveBeenCalled()
  expect(mocks.revoke).not.toHaveBeenCalled()
  expect(mocks.unbind).not.toHaveBeenCalled()
})

it('does not stop a completed import again', async () => {
  mocks.snapshot.mockResolvedValue({
    session: { id, legacyImport: { ...identity, complete: true } }
  })
  await closeConversation(id)
  expect(mocks.stop).not.toHaveBeenCalled()
  expect(mocks.close).toHaveBeenCalledWith(id)
})
