import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Session, SessionRecord } from '@clave/contract/sessions'
import { SERVER_LAYOUT_KEY } from '@clave/contract/sidebar'
import { startOidcProvider } from '../../../../tests/e2e/fixtures/oidc-provider.mjs'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { memoryDeviceStorage } from './port'
import { DEVICE_FORBIDDEN_MESSAGE } from './scope'
import { PendingRequests } from '../requests/service'
import { EchoAdapter } from '../../../../src/main/sessions/adapters/echo-adapter'
import { SessionManager } from '../../../../src/main/sessions/session-manager'
import { serverOwnedSessionHost } from '../../../../src/main/sessions/server-owned-host'
import { standaloneSidebar } from '../../../../src/main/server/standalone-sidebar'
import { Drafts, MemoryKeyValueStore } from '../../../mobile/src/chat/drafts'
import { MemorySecureStore, SecureCredentialStore } from '../../../mobile/src/machines/credentials'
import type { Machine } from '../../../mobile/src/machines/types'
import type { PushSocketConstructor } from '../../../mobile/src/api/push'
import type { ClaveServerClient, ClaveServerClientOptions } from '../../../mobile/src/api/client'

// Metadata reads use the real manager, producer, contract, router and device auth.
// The unused process ports refuse to reach a desktop or a provider.
vi.mock('electron', () => {
  throw new Error('The paired metadata fixture imported Electron.')
})
vi.mock('../../../../src/main/pty-manager', () => ({
  ptyManager: {
    getSessionRecord: () => {
      throw new Error('The fixture must use its exact-ID record source.')
    }
  }
}))
vi.mock('../../../../src/main/sessions/lifecycle', () => ({
  readScreen: vi.fn(),
  restartSession: vi.fn(),
  typeIntoSession: vi.fn(),
  resizeSession: vi.fn(),
  spawnSession: vi.fn(),
  stopSession: vi.fn(),
  writeTerminal: vi.fn()
}))
vi.mock('../../../../src/main/title-generator', () => ({ notifyChatMessage: vi.fn() }))
vi.mock('../../../../src/main/sessions/attachments', () => ({ preparePrompt: vi.fn() }))
vi.mock('../../../../src/main/sessions/chat-model-default', () => ({
  rememberChatEffort: vi.fn(),
  rememberChatModel: vi.fn()
}))
vi.mock('../../../../src/main/sessions/chat-view-default', () => ({ rememberChatView: vi.fn() }))
vi.mock('../../../../src/main/sessions/records', () => ({ sessionRecords: {} }))
import { createSessionHost } from '../../../../src/main/sessions/host'

type Issuer = Awaited<ReturnType<typeof startOidcProvider>>
interface MobileState {
  loadMachines(): Promise<void>
  loadSessions(machineId: string): Promise<void>
  connect(machineId: string): Promise<{ client: ClaveServerClient }>
  disconnectAll(): void
  sessions: Readonly<Record<string, readonly Session[]>>
  stamps: Readonly<Record<string, Readonly<Record<string, string | undefined>>>>
  sessionsError: Readonly<Record<string, string | null>>
}
interface MobileStore {
  getState(): MobileState
  setState(state: Pick<MobileState, 'stamps'>): void
}
interface ConsumerServices {
  build: 'development'
  credentials: SecureCredentialStore
  sources: { relay: { list(): Promise<Machine[]> }; developer: null }
  kv: MemoryKeyValueStore
  drafts: Drafts
  clientName: string
  clientOptions: Pick<ClaveServerClientOptions, 'fetch'>
  pushOptions: { WebSocket: PushSocketConstructor; build: 'development' }
}

async function mintIdentity(provider: Issuer): Promise<{ idToken: string; clientId: string }> {
  const redirect = 'clave://oauth/callback'
  const registration = await fetch(`${provider.issuer}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code']
    })
  })
  expect(registration.status).toBe(201)
  const { client_id: clientId } = (await registration.json()) as { client_id: string }
  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URL(`${provider.issuer}/authorize`)
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'openid profile email',
    state: 'paired-workspace-fixture',
    nonce: 'paired-workspace-fixture',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url')
  }).toString()
  const sent = await fetch(authorize, { redirect: 'manual' })
  expect(sent.status).toBe(302)
  const code = new URL(sent.headers.get('location')!).searchParams.get('code')!
  const exchanged = await fetch(`${provider.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier
    })
  })
  expect(exchanged.status).toBe(200)
  return { idToken: ((await exchanged.json()) as { id_token: string }).id_token, clientId }
}

const liveSession = (id: string): Session => ({
  id,
  provider: 'echo',
  adapterId: 'echo',
  transport: 'events',
  cwd: '/same-cwd-for-different-workspaces',
  windowKey: 'fixture-window',
  groupId: 'fixture-group',
  viewId: 'fixture/chat',
  title: `Phone ${id}`,
  createdAt: 123,
  state: 'idle'
})

type PrivateFixtureRecord = SessionRecord & { initialCommand: string; initialPrompt: string }
const privateRecord = (id: string, workspaceId?: string): PrivateFixtureRecord => ({
  id,
  cwd: '/same-cwd-for-different-workspaces',
  folderName: 'Fixture stopped',
  displayName: 'Kept stopped title',
  startedAt: 321,
  adapterId: 'codex-chat',
  transport: 'events',
  claudeMode: false,
  codexMode: true,
  piMode: false,
  antigravityMode: false,
  claudeAgentsMode: false,
  dangerousMode: false,
  tmuxName: 'PRIVATE-tmux-sentinel',
  claudeSessionId: 'PRIVATE-claude-sentinel',
  codexThreadId: 'PRIVATE-thread-sentinel',
  configDir: '/PRIVATE-config-sentinel',
  codexAccountId: 'PRIVATE-account-sentinel',
  codexAccountLabel: 'PRIVATE-label-sentinel',
  launchProfile: {
    id: 'PRIVATE-profile-sentinel',
    name: 'Private profile',
    family: 'codex',
    command: ['PRIVATE-command-sentinel'],
    additionalArgs: ['PRIVATE-args-sentinel']
  },
  view: { url: 'https://PRIVATE-view-sentinel.test', title: 'Private view' },
  initialCommand: 'PRIVATE-initial-command-sentinel',
  initialPrompt: 'PRIVATE-initial-prompt-sentinel',
  spawnedBy: 'PRIVATE-spawn-sentinel',
  link: { kind: 'toolbar', key: 'PRIVATE-link-sentinel' },
  ...(workspaceId !== undefined && { workspaceId })
})

// This fixture exercises HTTP and the real mobile store, without starting a
// push/reconnect workflow. Existing paired push fixtures cover that transport.
const DormantSocket = class {
  readyState = 0
  onopen = null
  onmessage = null
  onclose = null
  onerror = null
  send(): void {
    /* No push transport in this HTTP fixture. */
  }
  close(): void {
    /* No socket was opened. */
  }
} as unknown as PushSocketConstructor

it('serves authoritative live and stopped workspace stamps to a real paired phone without exposing desktop records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clave-paired-workspace-'))
  const manager = new SessionManager()
  const adapter = new EchoAdapter()
  let provider: Issuer | undefined
  let owned: ReturnType<typeof serverOwnedSessionHost> | undefined
  let requests: PendingRequests | undefined
  let server: EmbeddedServer | undefined
  let store: MobileStore | undefined
  let testFailure: unknown
  let testFailed = false
  const cleanupErrors: unknown[] = []
  try {
    provider = await startOidcProvider({
      user: {
        sub: 'paired-workspace-owner',
        email: 'paired-workspace@fixtures.test',
        name: 'Workspace fixture owner',
        email_verified: true
      }
    })
    manager.registerAdapter(adapter)
    const liveIds = ['live-a', 'live-legacy']
    for (const id of liveIds) {
      const stale = { ...liveSession(id), workspaceId: 'stale-manager-snapshot' }
      manager.adopt(stale, adapter.prepare(stale), adapter)
    }
    const ready = vi.spyOn(adapter, 'ready')
    const write = vi.spyOn(adapter, 'write')
    const spawn = vi.spyOn(adapter, 'spawn')
    const attach = vi.spyOn(adapter, 'attach')
    const adopt = vi.spyOn(manager, 'adopt')
    const lifecycle = { spawn: vi.fn(), stop: vi.fn(), resize: vi.fn(), writeTerminal: vi.fn() }
    const records = new Map([
      ['live-a', privateRecord('live-a', 'workspace-a')],
      ['live-legacy', privateRecord('live-legacy')],
      ['stopped-b', privateRecord('stopped-b', 'workspace-b')]
    ])
    const stampReads: string[] = []
    const host = createSessionHost({
      manager,
      lifecycle,
      workspaceIdOf: (id) => {
        stampReads.push(id)
        return records.get(id)?.workspaceId
      },
      records: {
        // Live records need not appear in the adoptable listing.
        listAdoptableRecords: () => [records.get('stopped-b')!],
        discardRecord: vi.fn(),
        release: vi.fn()
      }
    })
    const ownedReady = vi.fn()
    owned = serverOwnedSessionHost({
      host,
      dataDir: directory,
      sidebar: standaloneSidebar(directory),
      subscribeAll: (listener) => manager.subscribeAll(listener),
      ready: ownedReady
    })
    requests = new PendingRequests()
    server = await startEmbedded({
      ports: {
        sessions: owned.host,
        requests,
        devices: {
          storage: memoryDeviceStorage(),
          owner: () => 'paired-workspace-owner',
          issuer: provider.issuer,
          serverName: () => 'Paired workspace fixture'
        }
      }
    })
    const baseUrl = server.url
    const call = (
      method: 'GET' | 'POST',
      path: string,
      token: string | null,
      body?: unknown
    ): Promise<Response> =>
      fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
    const pairing = await call('POST', '/devices/pair', null, {
      ...(await mintIdentity(provider)),
      device: { name: 'Workspace fixture phone', platform: 'ios', appVersion: 'fixture' }
    })
    expect(pairing.status).toBe(200)
    const { pairingId } = (await pairing.json()) as { pairingId: string }
    expect((await call('POST', '/devices/approve', server.token, { pairingId })).status).toBe(200)
    const approval = await call('GET', `/devices/pair?id=${pairingId}`, null)
    expect(approval.status).toBe(200)
    const { deviceSession } = (await approval.json()) as {
      deviceSession: { token: string; deviceId: string }
    }
    const token = deviceSession.token
    expect(token).not.toBe(server.token)

    const expectedStopped = {
      id: 'stopped-b',
      cwd: '/same-cwd-for-different-workspaces',
      windowKey: SERVER_LAYOUT_KEY,
      state: 'ended',
      createdAt: 321,
      title: 'Kept stopped title',
      transport: 'events',
      adapterId: 'codex-chat',
      provider: 'codex',
      workspaceId: 'workspace-b'
    }
    const expected = [
      { ...liveSession('live-a'), workspaceId: 'workspace-a' },
      liveSession('live-legacy'),
      expectedStopped
    ]
    expect(owned.host.list()).toEqual(expected)
    expect(owned.host.get('stopped-b')).toEqual(expectedStopped)
    const listed = await call('GET', '/sessions', token)
    expect(listed.status).toBe(200)
    const raw = (await listed.json()) as Session[]
    expect(raw).toEqual(expected)
    expect(JSON.stringify(raw)).not.toContain('PRIVATE-')
    expect(JSON.stringify(raw)).not.toContain('stale-manager-snapshot')
    for (const session of expected) {
      const found = await call('GET', `/sessions/by-id?id=${session.id}`, token)
      expect(found.status).toBe(200)
      const body = await found.json()
      expect(body).toEqual(session)
      expect(JSON.stringify(body)).not.toContain('PRIVATE-')
    }
    expect(stampReads).toContain('live-a')
    expect(stampReads).toContain('live-legacy')

    const machine: Machine = {
      id: 'paired-fixture',
      name: 'Paired fixture',
      platform: 'macos',
      version: 'fixture',
      online: true,
      lastSeen: null,
      baseUrl,
      pushUrl: baseUrl.replace('http:', 'ws:') + '/push'
    }
    const credentials = new SecureCredentialStore(new MemorySecureStore())
    await credentials.set(machine.id, { serverUrl: baseUrl, bearer: token })
    const kv = new MemoryKeyValueStore()
    const paths: string[] = []
    // Load the actual browser consumer through Vitest, keeping its React Native
    // ambient declarations out of the server's Node TypeScript compilation.
    const { createStore } = await vi.importActual<{
      createStore(services: ConsumerServices): MobileStore
    }>('../../../mobile/src/state/store')
    store = createStore({
      build: 'development',
      credentials,
      sources: { relay: { list: async () => [machine] }, developer: null },
      kv,
      drafts: new Drafts(kv),
      clientName: 'paired-workspace-fixture',
      clientOptions: {
        fetch: async (url, init) => {
          expect(init.headers.Authorization).toBe(`Bearer ${token}`)
          paths.push(new URL(url).pathname)
          return fetch(url, init)
        }
      },
      pushOptions: { WebSocket: DormantSocket, build: 'development' }
    })
    await store.getState().loadMachines()
    store.setState({
      stamps: { [machine.id]: { 'live-a': 'old', 'live-legacy': 'old', removed: 'old' } }
    })
    await store.getState().loadSessions(machine.id)
    expect(store.getState().sessionsError[machine.id], JSON.stringify(paths)).toBeNull()
    expect(store.getState().sessions[machine.id]).toEqual(expected)
    expect(store.getState().stamps[machine.id]?.['live-a']).toBe('workspace-a')
    expect(store.getState().stamps[machine.id]?.['live-legacy']).toBeUndefined()
    expect(store.getState().stamps[machine.id]?.['stopped-b']).toBe('workspace-b')
    expect(store.getState().stamps[machine.id]).not.toHaveProperty('removed')
    const { client } = await store.getState().connect(machine.id)
    expect(await client.sessions.get('live-a')).toEqual(expected[0])
    expect(await client.sessions.get('stopped-b')).toEqual(expectedStopped)

    records.set('live-a', privateRecord('live-a', 'workspace-moved'))
    expect(await client.sessions.get('live-a')).toEqual({
      ...liveSession('live-a'),
      workspaceId: 'workspace-moved'
    })
    await store.getState().loadSessions(machine.id)
    expect(store.getState().stamps[machine.id]?.['live-a']).toBe('workspace-moved')
    records.set('live-a', privateRecord('live-a'))
    expect(await client.sessions.get('live-a')).not.toHaveProperty('workspaceId')
    await store.getState().loadSessions(machine.id)
    expect(store.getState().sessionsError[machine.id]).toBeNull()
    expect(store.getState().stamps[machine.id]?.['live-a']).toBeUndefined()
    records.delete('live-a')
    expect(await client.sessions.get('live-a')).not.toHaveProperty('workspaceId')
    await store.getState().loadSessions(machine.id)
    expect(store.getState().sessionsError[machine.id]).toBeNull()
    expect(store.getState().stamps[machine.id]?.['live-a']).toBeUndefined()
    records.set('live-a', privateRecord('live-a', 'workspace-restamped'))
    expect(await client.sessions.get('live-a')).toEqual({
      ...liveSession('live-a'),
      workspaceId: 'workspace-restamped'
    })
    await store.getState().loadSessions(machine.id)
    expect(store.getState().sessionsError[machine.id]).toBeNull()
    expect(store.getState().stamps[machine.id]?.['live-a']).toBe('workspace-restamped')
    records.set('live-a', privateRecord('live-a', ''))
    expect(await client.sessions.get('live-a')).toEqual({
      ...liveSession('live-a'),
      workspaceId: ''
    })
    await store.getState().loadSessions(machine.id)
    expect(store.getState().sessionsError[machine.id]).toBeNull()
    expect(store.getState().stamps[machine.id]?.['live-a']).toBe('')
    records.set('stopped-b', privateRecord('stopped-b'))
    expect(await client.sessions.get('stopped-b')).not.toHaveProperty('workspaceId')
    await store.getState().loadSessions(machine.id)
    expect(store.getState().sessionsError[machine.id]).toBeNull()
    expect(store.getState().stamps[machine.id]?.['stopped-b']).toBeUndefined()
    expect(paths).not.toContain('/sessions/records')
    expect(new Set(paths)).toEqual(new Set(['/sessions', '/sessions/by-id']))
    for (const path of ['/sessions/records', '/sessions/records?ids=live-a,stopped-b']) {
      const denied = await call('GET', path, token)
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({ error: 'Forbidden', message: DEVICE_FORBIDDEN_MESSAGE })
    }
    expect(manager.get('live-a')?.workspaceId).toBe('stale-manager-snapshot')
    for (const effect of [
      ready,
      write,
      spawn,
      attach,
      adopt,
      ownedReady,
      ...Object.values(lifecycle)
    ])
      expect(effect).not.toHaveBeenCalled()
  } catch (error) {
    testFailed = true
    testFailure = error
  } finally {
    const cleanup = [
      () => store?.getState().disconnectAll(),
      () => server?.stop(),
      () => requests?.close(),
      () => owned?.close(),
      ...manager.list().map((session) => () => manager.kill(session.id)),
      () => provider?.close(),
      () => rm(directory, { recursive: true, force: true }),
      () => vi.restoreAllMocks()
    ]
    for (const close of cleanup) {
      try {
        await close()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      testFailed ? [testFailure, ...cleanupErrors] : cleanupErrors,
      'Fixture cleanup failed.'
    )
  if (testFailed) throw testFailure
}, 15_000)
