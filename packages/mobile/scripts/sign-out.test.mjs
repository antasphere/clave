/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node integration verification */
import { createHash, randomBytes } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { startEmbedded } from '../../server/src/embedded'
import { FakeSource, aSession } from '../../server/src/test-support'
import { loadPushPorts } from '../../server/src/notify/credentials'
import { memoryDeviceStorage } from '../../server/src/devices/port'
import { DeviceStore } from '../../server/src/devices/store'
import { PendingRequests } from '../../server/src/requests/service'
import { startOidcProvider } from '../../../tests/e2e/fixtures/oidc-provider.mjs'
import { HubSignIn } from '../src/auth/sign-in'
import { MemorySecureStore, SecureCredentialStore } from '../src/machines/credentials'
import { Drafts, MemoryKeyValueStore } from '../src/chat/drafts'
import { ownerKeyValueStore } from '../src/auth/owner-storage'
import { EnrollmentClient } from '../src/enroll/client'
import { PUSH_CLEANUP_KEY } from '../src/notifications/cleanup'
const native = vi.hoisted(() => ({ platform: { OS: 'ios' }, token: vi.fn() }))
vi.mock('react-native', () => ({ Platform: native.platform }))
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }))
vi.mock('expo-device', () => ({}))
vi.mock('expo-image-picker', () => ({}))
vi.mock('expo-document-picker', () => ({}))
vi.mock('expo-file-system', () => ({ File: class {} }))
vi.mock('expo-notifications', () => ({
  getPermissionsAsync: async () => ({ granted: true }),
  requestPermissionsAsync: async () => ({ granted: true }),
  getDevicePushTokenAsync: native.token
}))
import { BetaServices } from '../src/platform/beta'
const cleanups = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function setup(platform) {
  native.platform.OS = platform
  native.token.mockResolvedValue({ type: platform, data: 'fixture-native-token' })
  const provider = await startOidcProvider({
    user: { sub: 'A', name: 'A', email: 'a@example.test', email_verified: true }
  })
  cleanups.push(() => provider.close())
  const push = loadPushPorts({
    dataDir: '/unused-local-fixture',
    fake: true,
    fakeTargets: false,
    log: () => {}
  })
  cleanups.push(() => push.close())
  const storage = memoryDeviceStorage()
  const registry = new DeviceStore(storage)
  const paired = registry.create({
    name: 'A phone',
    platform,
    appVersion: 'fixture'
  })
  const other = registry.create({ name: 'Another phone', platform, appVersion: 'fixture' })
  const requests = new PendingRequests()
  const server = await startEmbedded({
    ports: {
      sessions: new FakeSource(aSession('session')),
      ...push.ports,
      notify: { ...push.ports.notify, requestGraceMs: 0 },
      requests,
      devices: { storage, owner: () => 'A', issuer: provider.issuer, serverName: () => 'A Mac' }
    }
  })
  cleanups.push(() => server.stop())
  const nativeFetch = globalThis.fetch
  const auth = new HubSignIn({
    issuer: provider.issuer,
    secureStore: new MemorySecureStore(),
    fetch: nativeFetch,
    crypto: {
      randomBytes: (n) => new Uint8Array(randomBytes(n)),
      sha256: async (data) => new Uint8Array(createHash('sha256').update(data).digest())
    },
    openAuthSession: async (url) =>
      (await nativeFetch(url, { redirect: 'manual' })).headers.get('location')
  })
  await auth.signIn()
  const raw = new MemoryKeyValueStore()
  const kv = ownerKeyValueStore(raw, 'owner-A')
  const credentials = new SecureCredentialStore(new MemorySecureStore())
  await credentials.set('machine', { serverUrl: server.url, bearer: paired.token })
  const drafts = new Drafts(kv)
  await drafts.set('machine', 'session', 'returning owner draft')
  const beta = new BetaServices(
    auth,
    kv,
    credentials,
    drafts,
    'development',
    new SecureCredentialStore(new MemorySecureStore())
  )
  await beta.records.set({
    machineId: 'machine',
    serverId: 'server',
    deviceId: paired.device.id,
    serverName: 'A Mac',
    pairedAt: 1
  })
  await beta.registerPush('machine')
  expect(new DeviceStore(storage).pushTargets().length).toBe(1)
  return { beta, auth, provider, storage, requests, push, paired, other, server, raw }
}
async function signInAs(auth, provider, sub) {
  provider.state.user = {
    sub,
    name: sub,
    email: `${sub.toLowerCase()}@example.test`,
    email_verified: true
  }
  await auth.signIn()
  expect(auth.status().account?.subject).toBe(sub)
}
for (const platform of ['ios', 'android'])
  it(`clears only the captured A ${platform} target before B login and later A question`, async () => {
    const { beta, auth, provider, storage, requests, push, paired, other, server, raw } =
      await setup(platform)
    await new EnrollmentClient(server.url, { build: 'development' }).setPushToken(
      other.token,
      'other-phone-native-token',
      platform
    )
    const access = vi.spyOn(auth, 'accessToken')
    const id = vi.spyOn(auth, 'idToken')
    expect(await beta.signOut()).toEqual({ pending: 0, retryRecorded: true })
    await signInAs(auth, provider, 'B')
    const targets = new DeviceStore(storage).pushTargets()
    expect(targets.some((target) => target.deviceId === paired.device.id)).toBe(false)
    expect(targets.some((target) => target.deviceId === other.device.id)).toBe(true)
    requests.create({
      sessionId: 'session',
      kind: 'clarification',
      description: 'A fixture question',
      options: [],
      questions: [{ question: 'A fixture preview', options: [] }]
    })
    await vi.waitFor(() => expect(push.hooks.sent().length).toBe(1))
    expect(push.hooks.sent().some((send) => send.deviceId === paired.device.id)).toBe(false)
    expect(await beta.drafts.get('machine', 'session')).toBe('returning owner draft')
    expect(await new Drafts(ownerKeyValueStore(raw, 'owner-B')).get('machine', 'session')).toBe('')
    expect(access).not.toHaveBeenCalled()
    expect(id).not.toHaveBeenCalled()
  })
it('drains late token registration before clearing and refuses all newly queued registration', async () => {
  const { beta, storage } = await setup('ios')
  const nativeFetch = globalThis.fetch
  let release
  let waiting = false
  let clears = 0
  vi.stubGlobal('fetch', async (url, init) => {
    if (url.endsWith('/push-token/clear')) clears++
    if (url.endsWith('/push-token')) {
      waiting = true
      await new Promise((resolve) => {
        release = resolve
      })
    }
    return nativeFetch(url, init)
  })
  const rotation = beta.syncPushTokens({ type: 'ios', data: 'rotated-native-token' })
  await vi.waitFor(() => expect(waiting).toBe(true))
  const logout = beta.signOut()
  try {
    await new Promise((resolve) => setImmediate(resolve))
    expect(clears).toBe(0)
  } finally {
    release()
  }
  await Promise.all([rotation, logout])
  expect(clears).toBe(1)
  expect(new DeviceStore(storage).pushTargets()).toEqual([])
  expect(await beta.syncPushTokens({ type: 'ios', data: 'too-late-native-token' })).toEqual([])
  expect(new DeviceStore(storage).pushTargets()).toEqual([])
})
it('retains A cleanup for same-owner retry when offline, without letting B retry A cleanup', async () => {
  const { beta, auth, provider, storage, raw } = await setup('ios')
  const nativeFetch = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline fixture')
    })
  )
  expect(await beta.signOut()).toEqual({ pending: 1, retryRecorded: true })
  expect(new DeviceStore(storage).pushTargets().length).toBe(1)
  expect(JSON.parse(await beta.kv.getItem(PUSH_CLEANUP_KEY)).refs).toEqual([
    expect.stringMatching(/^push-cleanup-/)
  ])
  await signInAs(auth, provider, 'B')
  const bkv = ownerKeyValueStore(raw, 'owner-B')
  const other = new BetaServices(
    auth,
    bkv,
    new SecureCredentialStore(new MemorySecureStore()),
    new Drafts(bkv),
    'development',
    new SecureCredentialStore(new MemorySecureStore())
  )
  expect(await other.syncPushTokens()).toEqual([])
  expect(new DeviceStore(storage).pushTargets().length).toBe(1)
  vi.stubGlobal('fetch', nativeFetch)
  await signInAs(auth, provider, 'A')
  const returning = new BetaServices(
    auth,
    beta.kv,
    beta.credentials,
    beta.drafts,
    'development',
    beta.cleanupCredentials
  )
  expect((await returning.syncPushTokens()).map((result) => result.kind)).toEqual(['registered'])
  expect(await beta.kv.getItem(PUSH_CLEANUP_KEY)).toBeNull()
  expect(await beta.drafts.get('machine', 'session')).toBe('returning owner draft')
})

it('clears multiple paired servers through each captured device credential', async () => {
  const { beta, provider, storage, push } = await setup('ios')
  const secondStorage = memoryDeviceStorage()
  const secondPair = new DeviceStore(secondStorage).create({
    name: 'A second machine phone',
    platform: 'ios',
    appVersion: 'fixture'
  })
  const second = await startEmbedded({
    ports: {
      sessions: new FakeSource(aSession('second-session')),
      ...push.ports,
      devices: {
        storage: secondStorage,
        owner: () => 'A',
        issuer: provider.issuer,
        serverName: () => 'A second Mac'
      }
    }
  })
  cleanups.push(() => second.stop())
  await beta.credentials.set('second-machine', { serverUrl: second.url, bearer: secondPair.token })
  await beta.records.set({
    machineId: 'second-machine',
    serverId: 'second-server',
    deviceId: secondPair.device.id,
    serverName: 'A second Mac',
    pairedAt: 1
  })
  await beta.registerPush('second-machine')
  expect(new DeviceStore(secondStorage).pushTargets().length).toBe(1)
  expect(await beta.signOut()).toEqual({ pending: 0, retryRecorded: true })
  expect(new DeviceStore(storage).pushTargets()).toEqual([])
  expect(new DeviceStore(secondStorage).pushTargets()).toEqual([])
})

it('finishes captured A cleanup without reading B credentials or signing B out during a delayed clear', async () => {
  const { beta, auth, provider, storage, paired } = await setup('ios')
  const nativeFetch = globalThis.fetch
  let release
  let waiting = false
  let onlyCapturedCredential = true
  vi.stubGlobal('fetch', async (url, init) => {
    const response = await nativeFetch(url, init)
    if (url.endsWith('/push-token/clear')) {
      onlyCapturedCredential =
        onlyCapturedCredential && init.headers.Authorization === `Bearer ${paired.token}`
      waiting = true
      await new Promise((resolve) => {
        release = resolve
      })
    }
    return response
  })
  const access = vi.spyOn(auth, 'accessToken')
  const id = vi.spyOn(auth, 'idToken')
  const globalSignOut = vi.spyOn(auth, 'signOut')
  const cleanup = beta.signOut()
  await vi.waitFor(() => expect(waiting).toBe(true))
  try {
    await signInAs(auth, provider, 'B')
  } finally {
    release()
  }
  expect(await cleanup).toEqual({ pending: 0, retryRecorded: true })
  expect(auth.status().account?.subject).toBe('B')
  expect(new DeviceStore(storage).pushTargets()).toEqual([])
  expect(onlyCapturedCredential).toBe(true)
  expect(access).not.toHaveBeenCalled()
  expect(id).not.toHaveBeenCalled()
  expect(globalSignOut).not.toHaveBeenCalled()
})

for (const platform of ['ios', 'android'])
  it(`retains old-road ${platform} cleanup across a relay change before sign-out`, async () => {
    const { beta, auth, provider, storage, requests, push, paired, other, server } =
      await setup(platform)
    await new EnrollmentClient(server.url, { build: 'development' }).setPushToken(
      other.token,
      'other-phone-native-token',
      platform
    )
    const nativeFetch = globalThis.fetch
    let newRoadRequests = 0
    vi.stubGlobal('fetch', async (url, init) => {
      if (url.startsWith('http://127.0.0.1:8789/')) {
        newRoadRequests++
        throw new Error('Old cleanup must never use the new road')
      }
      return nativeFetch(url, init)
    })
    await beta.setRelayUrl('http://127.0.0.1:8789')
    expect(await beta.credentials.get('machine')).toBeNull()
    expect(await beta.records.list()).toEqual([])
    expect(await beta.signOut()).toEqual({ pending: 0, retryRecorded: true })
    await signInAs(auth, provider, 'B')
    requests.create({
      sessionId: 'session',
      kind: 'clarification',
      description: 'A fixture question',
      options: [],
      questions: [{ question: 'A fixture preview', options: [] }]
    })
    await vi.waitFor(() =>
      expect(push.hooks.sent().some((send) => send.deviceId === other.device.id)).toBe(true)
    )
    expect(newRoadRequests).toBe(0)
    expect(
      new DeviceStore(storage).pushTargets().some((target) => target.deviceId === paired.device.id)
    ).toBe(false)
    expect(push.hooks.sent().some((send) => send.deviceId === paired.device.id)).toBe(false)
    expect(await beta.drafts.get('machine', 'session')).toBe('returning owner draft')
  })

it('keeps an encrypted old-road cleanup context after an offline relay change and retries only for A', async () => {
  const { beta, auth, provider, storage, paired, server, raw } = await setup('ios')
  const nativeFetch = globalThis.fetch
  let clearAttempts = 0
  vi.stubGlobal('fetch', async (url, init) => {
    if (url === server.url + '/devices/me/push-token/clear') {
      clearAttempts++
      throw new Error('old machine offline')
    }
    return nativeFetch(url, init)
  })
  expect(await beta.setRelayUrl('http://127.0.0.1:8789')).toEqual({
    pending: 1,
    retryRecorded: true
  })
  expect(await beta.credentials.get('machine')).toBeNull()
  expect(await beta.records.list()).toEqual([])
  const encoded = await beta.kv.getItem(PUSH_CLEANUP_KEY)
  expect(encoded.includes(paired.token) || encoded.includes(server.url)).toBe(false)
  expect(
    [...raw.map.values()].some(
      (value) => value.includes(paired.token) || value.includes(server.url)
    )
  ).toBe(false)
  const {
    v,
    refs: [pending]
  } = JSON.parse(encoded)
  expect(v).toBe(2)
  expect(Object.keys(JSON.parse(encoded)).sort()).toEqual(['refs', 'v'])
  const stored = await beta.cleanupCredentials.get(pending)
  expect(stored.bearer === paired.token && stored.serverUrl === server.url).toBe(true)
  expect(await beta.signOut()).toEqual({ pending: 1, retryRecorded: true })
  await signInAs(auth, provider, 'B')
  const attemptsBeforeB = clearAttempts
  const bkv = ownerKeyValueStore(raw, 'owner-B')
  const b = new BetaServices(
    auth,
    bkv,
    new SecureCredentialStore(new MemorySecureStore()),
    new Drafts(bkv),
    'development',
    new SecureCredentialStore(new MemorySecureStore())
  )
  expect(await b.syncPushTokens()).toEqual([])
  expect(clearAttempts).toBe(attemptsBeforeB)
  vi.stubGlobal('fetch', nativeFetch)
  await signInAs(auth, provider, 'A')
  const returning = new BetaServices(
    auth,
    beta.kv,
    beta.credentials,
    beta.drafts,
    'development',
    beta.cleanupCredentials
  )
  expect(await returning.syncPushTokens()).toEqual([])
  expect(new DeviceStore(storage).pushTargets()).toEqual([])
  expect(await beta.kv.getItem(PUSH_CLEANUP_KEY)).toBeNull()
  expect(await beta.cleanupCredentials.get(pending)).toBeNull()
  expect(await beta.drafts.get('machine', 'session')).toBe('returning owner draft')
})

it('does not forget an active pairing when encrypted cleanup context cannot be saved', async () => {
  const { beta, storage } = await setup('ios')
  vi.spyOn(beta.cleanupCredentials, 'set').mockRejectedValueOnce(new Error('secure storage failed'))
  await expect(beta.setRelayUrl('http://127.0.0.1:8789')).rejects.toThrow('secure storage failed')
  expect((await beta.credentials.get('machine')) !== null).toBe(true)
  expect((await beta.records.list()).length).toBe(1)
  expect(new DeviceStore(storage).pushTargets().length).toBe(1)
  expect(await beta.kv.getItem('relay-url')).toBeNull()
})

it('does not replace an old-road cleanup credential when a new pairing reuses its machine ID', async () => {
  const { beta, auth, provider, storage, server, push } = await setup('ios')
  const nativeFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (url, init) => {
    if (url === server.url + '/devices/me/push-token/clear') throw new Error('old machine offline')
    return nativeFetch(url, init)
  })
  await beta.setRelayUrl('http://127.0.0.1:8789')
  const {
    refs: [old]
  } = JSON.parse(await beta.kv.getItem(PUSH_CLEANUP_KEY))
  const secondStorage = memoryDeviceStorage()
  const secondPair = new DeviceStore(secondStorage).create({
    name: 'Replacement phone pairing',
    platform: 'ios',
    appVersion: 'fixture'
  })
  const second = await startEmbedded({
    ports: {
      sessions: new FakeSource(aSession('new-session')),
      ...push.ports,
      devices: {
        storage: secondStorage,
        owner: () => 'A',
        issuer: provider.issuer,
        serverName: () => 'New Mac'
      }
    }
  })
  cleanups.push(() => second.stop())
  await beta.credentials.set('machine', { serverUrl: second.url, bearer: secondPair.token })
  await beta.records.set({
    machineId: 'machine',
    serverId: 'new-server',
    deviceId: secondPair.device.id,
    serverName: 'New Mac',
    pairedAt: 2
  })
  await beta.registerPush('machine')
  expect(await beta.signOut()).toEqual({ pending: 1, retryRecorded: true })
  expect(new DeviceStore(secondStorage).pushTargets()).toEqual([])
  expect(new DeviceStore(storage).pushTargets().length).toBe(1)
  const retained = await beta.cleanupCredentials.get(old)
  expect(retained.serverUrl === server.url).toBe(true)
  vi.stubGlobal('fetch', nativeFetch)
  await signInAs(auth, provider, 'A')
  const returning = new BetaServices(
    auth,
    beta.kv,
    beta.credentials,
    beta.drafts,
    'development',
    beta.cleanupCredentials
  )
  expect((await returning.syncPushTokens()).map((result) => result.kind)).toEqual(['registered'])
  expect(new DeviceStore(storage).pushTargets()).toEqual([])
  expect(new DeviceStore(secondStorage).pushTargets().length).toBe(1)
  expect(await beta.kv.getItem(PUSH_CLEANUP_KEY)).toBeNull()
})

it('orders a returning A service behind the prior A sign-out so cleanup cannot erase its new registration', async () => {
  const { beta, auth, provider, storage, server } = await setup('ios')
  const nativeFetch = globalThis.fetch
  let release
  let waiting = false
  let newRegistrations = 0
  let clearCalls = 0
  vi.stubGlobal('fetch', async (url, init) => {
    if (url === server.url + '/devices/me/push-token/clear' && ++clearCalls === 1) {
      waiting = true
      await new Promise((resolve) => {
        release = resolve
      })
    }
    if (url === server.url + '/devices/me/push-token') newRegistrations++
    return nativeFetch(url, init)
  })
  const logout = beta.signOut()
  await vi.waitFor(() => expect(waiting).toBe(true))
  await signInAs(auth, provider, 'B')
  await signInAs(auth, provider, 'A')
  const returning = new BetaServices(
    auth,
    beta.kv,
    beta.credentials,
    beta.drafts,
    'development',
    beta.cleanupCredentials,
    undefined,
    beta.pushWork
  )
  const registration = returning.syncPushTokens({ type: 'ios', data: 'returning-A-token' })
  await new Promise((resolve) => setImmediate(resolve))
  const dispatchedBeforeClear = newRegistrations
  const overlappingClears = clearCalls
  release()
  await Promise.all([logout, registration])
  expect(overlappingClears).toBe(1)
  expect(dispatchedBeforeClear).toBe(0)
  expect(
    new DeviceStore(storage).pushTargets().some((target) => target.token === 'returning-A-token')
  ).toBe(true)
  expect(auth.status().account?.subject).toBe('A')
})

it('finishes an in-flight rotation before a relay change clears and forgets the old target', async () => {
  const { beta, storage, server } = await setup('ios')
  const nativeFetch = globalThis.fetch
  let release
  let waiting = false
  let clears = 0
  vi.stubGlobal('fetch', async (url, init) => {
    if (url === server.url + '/devices/me/push-token') {
      waiting = true
      await new Promise((resolve) => {
        release = resolve
      })
    }
    if (url === server.url + '/devices/me/push-token/clear') clears++
    return nativeFetch(url, init)
  })
  const rotation = beta.syncPushTokens({ type: 'ios', data: 'late-old-road-token' })
  await vi.waitFor(() => expect(waiting).toBe(true))
  const relay = beta.setRelayUrl('http://127.0.0.1:8789')
  await new Promise((resolve) => setImmediate(resolve))
  const earlyClears = clears
  const retainedWhileWaiting = (await beta.credentials.get('machine')) !== null
  release()
  await Promise.all([rotation, relay])
  expect(earlyClears).toBe(0)
  expect(retainedWhileWaiting).toBe(true)
  expect(clears).toBe(1)
  expect(new DeviceStore(storage).pushTargets()).toEqual([])
  expect(await beta.credentials.get('machine')).toBeNull()
})

it('registers again after a pending retry clears a token registered during an earlier failed clear', async () => {
  const { beta, auth, provider, storage, server } = await setup('ios')
  const nativeFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (url, init) => {
    if (url === server.url + '/devices/me/push-token/clear') throw new Error('clear unreachable')
    return nativeFetch(url, init)
  })
  expect((await beta.signOut()).pending).toBe(1)
  await signInAs(auth, provider, 'A')
  const returning = new BetaServices(
    auth,
    beta.kv,
    beta.credentials,
    beta.drafts,
    'development',
    beta.cleanupCredentials,
    undefined,
    beta.pushWork
  )
  const token = { type: 'ios', data: 'current-owner-token' }
  expect((await returning.syncPushTokens(token)).map((result) => result.kind)).toEqual([
    'failed',
    'registered'
  ])
  vi.stubGlobal('fetch', nativeFetch)
  expect((await returning.syncPushTokens(token)).map((result) => result.kind)).toEqual([
    'registered'
  ])
  expect(new DeviceStore(storage).pushTargets().some((target) => target.token === token.data)).toBe(
    true
  )
})
