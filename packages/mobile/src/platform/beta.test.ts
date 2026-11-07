import { afterEach, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { startOidcProvider } from '../../../../tests/e2e/fixtures/oidc-provider.mjs'
import { Drafts, MemoryKeyValueStore } from '../chat/drafts'
import { MemorySecureStore, SecureCredentialStore } from '../machines/credentials'
import { AuthError, HubSignIn } from '../auth/sign-in'
import { pushTokenKey } from '../notifications/token'

const native = vi.hoisted(() => ({
  permissions: vi.fn(async () => ({ granted: true })),
  request: vi.fn(async () => ({ granted: true })),
  token: vi.fn(async () => ({ type: 'ios', data: 'boot-token' }))
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }))
vi.mock('expo-device', () => ({}))
vi.mock('expo-image-picker', () => ({}))
vi.mock('expo-document-picker', () => ({}))
vi.mock('expo-file-system', () => ({ File: class {} }))
vi.mock('expo-notifications', () => ({
  getPermissionsAsync: native.permissions,
  requestPermissionsAsync: native.request,
  getDevicePushTokenAsync: native.token
}))
import { BetaServices } from './beta'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function setup(): Promise<{ beta: BetaServices; kv: MemoryKeyValueStore }> {
  const kv = new MemoryKeyValueStore()
  const credentials = new SecureCredentialStore(new MemorySecureStore())
  const beta = new BetaServices(
    { guardAccount: () => () => {} } as unknown as HubSignIn,
    kv,
    credentials,
    new Drafts(kv),
    'development',
    new SecureCredentialStore(new MemorySecureStore())
  )
  for (const id of ['first', 'second']) {
    await credentials.set(id, {
      serverUrl: `http://127.0.0.1:43202/${id}`,
      bearer: `fixture-${id}`
    })
    await beta.records.set({
      machineId: id,
      deviceId: id,
      serverId: id,
      serverName: 'Fixture',
      pairedAt: 1
    })
  }
  return { beta, kv }
}

it('registers the raw token for every paired server on boot and rotation without prompting', async () => {
  const writes: unknown[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    writes.push({
      bearer: (init.headers as Record<string, string>).Authorization,
      body: JSON.parse(String(init.body))
    })
    return Response.json({})
  })
  const { beta, kv } = await setup()
  expect((await beta.syncPushTokens()).map((r) => r.kind)).toEqual(['registered', 'registered'])
  expect((await beta.syncPushTokens()).map((r) => r.kind)).toEqual(['unchanged', 'unchanged'])
  await beta.syncPushTokens({ type: 'ios', data: 'rotated-token' })
  expect(writes).toHaveLength(4)
  expect(writes.slice(-2)).toEqual([
    { bearer: 'Bearer fixture-first', body: { token: 'rotated-token', platform: 'ios' } },
    { bearer: 'Bearer fixture-second', body: { token: 'rotated-token', platform: 'ios' } }
  ])
  expect(native.request).not.toHaveBeenCalled()
  expect(await kv.getItem(pushTokenKey('first'))).toBe('rotated-token')
})

it('finishes an older registration before a rotation so it cannot overwrite the newer token', async () => {
  let release: (() => void) | undefined
  let calls = 0
  vi.stubGlobal('fetch', async () => {
    if (++calls === 1)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    return Response.json({})
  })
  const { beta, kv } = await setup()
  const boot = beta.syncPushTokens()
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const rotation = beta.syncPushTokens({ type: 'ios', data: 'new-token' })
  try {
    // Drain the queued rotation's microtasks while the older HTTP write is held.
    // A missing serialization chain would dispatch and persist the new token now.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(calls).toBe(1)
    expect(await kv.getItem(pushTokenKey('first'))).toBeNull()
  } finally {
    release!()
  }
  await Promise.all([boot, rotation])
  expect(await kv.getItem(pushTokenKey('first'))).toBe('new-token')
  expect(await kv.getItem(pushTokenKey('second'))).toBe('new-token')
})

it('does not use a later owner token when relay configuration was read by the old owner', async () => {
  let currentOwner = 'A'
  let release!: () => void
  let waiting = false
  const kv = new MemoryKeyValueStore()
  const getItem = kv.getItem.bind(kv)
  kv.getItem = async (key) => {
    if (key === 'relay-url') {
      waiting = true
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return 'http://127.0.0.1:8789'
    }
    return getItem(key)
  }
  const accessToken = vi.fn(async () => `token-${currentOwner}`)
  const auth = {
    status: () => ({ account: { subject: currentOwner } }),
    accessToken,
    guardAccount: () => {
      const owner = currentOwner
      return () => {
        if (currentOwner !== owner) throw new AuthError('cancelled', 'Account changed.')
      }
    }
  } as unknown as HubSignIn
  const beta = new BetaServices(
    auth,
    kv,
    new SecureCredentialStore(new MemorySecureStore()),
    new Drafts(kv),
    'development',
    new SecureCredentialStore(new MemorySecureStore())
  )
  const request = vi.fn(async () =>
    Response.json({ machines: [{ id: 'B-machine', online: true }] })
  )
  vi.stubGlobal('fetch', request)
  const oldRead = beta.source.list().then(
    () => 'resolved',
    () => 'rejected'
  )
  await vi.waitFor(() => expect(waiting).toBe(true))
  currentOwner = 'B'
  release()
  expect(await oldRead).toBe('rejected')
  expect(accessToken).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
  expect(await getItem('machines-cache')).toBeNull()
})

it('refuses captured A relay and pairing transports after a real local-OIDC switch to B', async () => {
  const provider = await startOidcProvider()
  const nativeFetch = globalThis.fetch
  const auth = new HubSignIn({
    issuer: provider.issuer,
    fetch: nativeFetch,
    secureStore: new MemorySecureStore(),
    crypto: {
      randomBytes: (n) => new Uint8Array(randomBytes(n)),
      sha256: async (data) => new Uint8Array(createHash('sha256').update(data).digest())
    },
    openAuthSession: async (url) =>
      (await nativeFetch(url, { redirect: 'manual' })).headers.get('location')
  })
  try {
    await auth.signIn()
    const kv = new MemoryKeyValueStore()
    await kv.setItem('relay-url', 'http://127.0.0.1:8789')
    const beta = new BetaServices(
      auth,
      kv,
      new SecureCredentialStore(new MemorySecureStore()),
      new Drafts(kv),
      'development',
      new SecureCredentialStore(new MemorySecureStore())
    )
    await auth.signOut()
    provider.state.user = {
      sub: 'owner-B',
      name: 'B',
      email: 'b@example.test',
      email_verified: true
    }
    await auth.signIn()
    expect(auth.status().account?.subject).toBe('owner-B')
    const transport = vi.fn(async () => Response.json({ machines: [] }))
    vi.stubGlobal('fetch', transport)
    await expect(beta.source.list()).rejects.toMatchObject({ failure: 'cancelled' })
    await expect(
      beta.pair(
        {
          id: 'A-machine',
          name: 'A',
          baseUrl: 'http://127.0.0.1:43202',
          pushUrl: 'ws://127.0.0.1:43202/push',
          platform: 'macos',
          version: 'test',
          online: true,
          lastSeen: null
        },
        () => {},
        () => false
      )
    ).rejects.toMatchObject({ failure: 'cancelled' })
    expect(transport).not.toHaveBeenCalled()
    expect(await kv.getItem('machines-cache')).toBeNull()
    expect(await beta.records.list()).toEqual([])
  } finally {
    await provider.close()
  }
})
