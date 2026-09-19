import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterLaunch } from './adapter'
import type {
  ConversationOptions,
  ConversationSession,
  ConversationSnapshot
} from '../../shared/agent-session'

const fixture = vi.hoisted(() => {
  const session: ConversationSession = {
    id: 'conversation-7b7a0f34-ff31-4377-9725-f2a806a92a92',
    provider: 'claude',
    pluginBindings: {
      provider: { pluginId: 'clave.claude', revision: 'builtin', version: '1.0.0' },
      views: []
    },
    cwd: '/tmp',
    title: 'test',
    status: 'idle',
    createdAt: '',
    updatedAt: '',
    capabilities: { permissions: true, questions: true, resume: true }
  }
  const client = {
    isConnected: vi.fn(() => true),
    disconnect: vi.fn(),
    onEvent: vi.fn(),
    create: vi.fn<
      (options: ConversationOptions, launch: AdapterLaunch) => Promise<ConversationSnapshot>
    >(async (options) => ({
      session: { ...session, ...options },
      sequence: 0,
      entries: [],
      requests: []
    })),
    snapshot: vi.fn(async () => ({ session, sequence: 0, entries: [], requests: [] })),
    send: vi.fn<
      (_id: string, _text: string, _commandId: string, launch: AdapterLaunch) => Promise<void>
    >(async () => {}),
    list: vi.fn(async () => []),
    updateMetadata: vi.fn(async () => {}),
    close: vi.fn(async () => {})
  }
  return {
    client,
    connect: vi.fn(async () => client),
    session,
    bind: vi.fn(),
    trusted: vi.fn(() => true),
    trust: vi.fn(),
    confirm: vi.fn(async () => ({ response: 0 }))
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/fixture-userdata' },
  dialog: { showMessageBox: fixture.confirm }
}))
vi.mock('../ipc-handlers/clave-file-handlers', () => ({
  isUnderTrustedRoot: fixture.trusted,
  addTrustedRoot: fixture.trust
}))
vi.mock('../runtime-plugins/host', () => ({ revokePluginSessionViews: vi.fn() }))
vi.mock('../runtime-plugins/registry-runtime', () => ({
  runtimePluginRegistry: () => ({
    resolveProvider: (provider: string) => ({
      descriptor: { name: provider },
      command: [provider]
    }),
    bindingsFor: (provider: string) => ({
      provider: { pluginId: `clave.${provider}`, revision: 'builtin', version: '1.0.0' },
      views: []
    })
  })
}))
vi.mock('./client', () => ({ ConversationClient: { connect: fixture.connect } }))
vi.mock('../launch-profile-manager', () => ({
  launchProfileManager: {
    resolve: (provider) => ({
      id: `profile-${provider}`,
      command: [provider],
      additionalArgs: [],
      pi: { provider: 'fixture-provider', model: 'fixture-model', thinking: 'high' }
    })
  }
}))
vi.mock('../pty-manager', () => ({
  getLoginShellEnv: () => ({
    PATH: '/usr/bin',
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-inherited',
    ELECTRON_RUN_AS_NODE: '1'
  }),
  buildSpawnEnv: (env, account) => ({
    ...env,
    ...(account.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: account.oauthToken } : {})
  }),
  accountTokenForSpawn: () => 'fixture-selected-account'
}))
vi.mock('../mcp/mcp-runtime', () => ({
  writeSessionMcpConfig: () => '/tmp/private-mcp.json',
  deleteSessionMcpConfig: vi.fn()
}))
vi.mock('../window-registry', () => ({
  windowRegistry: {
    getWorkspaceForWindow: () => 'workspace-a',
    getKeyForWindow: () => 'window-a',
    getWindowForSession: () => null,
    bindSession: fixture.bind,
    unbindSession: vi.fn(),
    listWindows: () => [],
    isPrimary: () => true
  }
}))
vi.mock('../window-state', () => ({ windowState: { list: () => [{ key: 'window-a' }] } }))

import {
  conversationClient,
  createConversation,
  disconnectConversationClient,
  sendConversation
} from './runtime'
import type { BrowserWindow } from 'electron'

describe('main-process conversation integration', () => {
  beforeEach(async () => {
    disconnectConversationClient()
    await Promise.resolve()
    vi.clearAllMocks()
    fixture.client.isConnected.mockReturnValue(true)
    fixture.trusted.mockReturnValue(true)
  })

  it('pins resolved profile defaults and home identity in the durable session', async () => {
    const snapshot = await createConversation({ id: 7 } as BrowserWindow, {
      provider: 'pi',
      cwd: '/tmp'
    })
    expect(snapshot.session).toMatchObject({
      provider: 'pi',
      launchProfileId: 'profile-pi',
      model: 'fixture-model',
      piProvider: 'fixture-provider',
      piThinking: 'high',
      workspaceId: 'workspace-a',
      windowKey: 'window-a'
    })
    const launch = fixture.client.create.mock.calls[0][1]
    expect(launch.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
    expect(launch.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  it('hands account credentials and MCP identity to the private launch, not public options', async () => {
    await sendConversation(fixture.session.id, 'hello', 'command-one')
    const [id, text, commandId, launch] = fixture.client.send.mock.calls[0]
    expect([id, text, commandId]).toEqual([fixture.session.id, 'hello', 'command-one'])
    expect(launch.env.CLAVE_SESSION_ID).toBe(id)
    expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-selected-account')
    expect(launch.mcpConfigPath).toBe('/tmp/private-mcp.json')
    expect(JSON.stringify(launch.options)).not.toContain('fixture-selected-account')
  })

  it('reconnects the next operation after a lost transport without replaying a send', async () => {
    await conversationClient()
    fixture.client.isConnected.mockReturnValueOnce(false)
    await conversationClient()
    expect(fixture.connect).toHaveBeenCalledTimes(2)
    expect(fixture.client.send).not.toHaveBeenCalled()
  })

  it('does not re-resolve an already connected provider when the desktop build changes', async () => {
    fixture.client.snapshot.mockResolvedValueOnce(
      Object.assign(await fixture.client.snapshot(), { providerConnected: true })
    )
    await sendConversation(fixture.session.id, 'continue with the pinned provider', 'existing')
    expect(fixture.client.send).toHaveBeenCalledWith(
      fixture.session.id,
      'continue with the pinned provider',
      'existing',
      undefined
    )
  })

  it('does not initialize a headless provider before workspace trust is granted', async () => {
    fixture.trusted.mockReturnValue(false)
    const win = { id: 7, isDestroyed: () => false } as BrowserWindow
    await expect(createConversation(win, { provider: 'claude', cwd: '/tmp' })).rejects.toThrow(
      'not trusted'
    )
    expect(fixture.client.create).not.toHaveBeenCalled()
    fixture.confirm.mockResolvedValueOnce({ response: 1 })
    await createConversation(win, { provider: 'claude', cwd: '/tmp' })
    expect(fixture.trust).toHaveBeenCalledWith('/tmp')
    expect(fixture.client.create).toHaveBeenCalledOnce()
  })
})
