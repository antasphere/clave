import { afterEach, expect, it, vi } from 'vitest'
import { Drafts, MemoryKeyValueStore } from '../chat/drafts'
import { MemorySecureStore, SecureCredentialStore } from '../machines/credentials'
import type { HubSignIn } from '../auth/sign-in'
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
  const beta = new BetaServices({} as HubSignIn, kv, credentials, new Drafts(kv), 'development')
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
  release!()
  await Promise.all([boot, rotation])
  expect(await kv.getItem(pushTokenKey('first'))).toBe('new-token')
  expect(await kv.getItem(pushTokenKey('second'))).toBe('new-token')
})
