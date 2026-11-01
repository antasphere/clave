/* eslint-disable @typescript-eslint/explicit-function-return-type -- local native-adapter integration verification */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { startEmbedded } from '../../server/src/embedded'
import { FakeSource, aSession } from '../../server/src/test-support'
import { memoryDeviceStorage } from '../../server/src/devices/port'
import { DeviceStore } from '../../server/src/devices/store'
import { startOidcProvider } from '../../../tests/e2e/fixtures/oidc-provider.mjs'
import { HubSignIn } from '../src/auth/sign-in'
import { MemorySecureStore } from '../src/machines/credentials'
import { Drafts } from '../src/chat/drafts'
import { nativeOwnerStores } from '../src/platform/account'
import { BetaServices } from '../src/platform/beta'
import { createStore } from '../src/state/store'

const native = vi.hoisted(() => ({ plain: new Map(), secure: new Map() }))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key) => native.plain.get(key) ?? null,
    setItem: async (key, value) => {
      native.plain.set(key, value)
    },
    removeItem: async (key) => {
      native.plain.delete(key)
    }
  }
}))
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key) => native.secure.get(key) ?? null,
  setItemAsync: async (key, value) => {
    native.secure.set(key, value)
  },
  deleteItemAsync: async (key) => {
    native.secure.delete(key)
  }
}))
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'sha256' },
  digestStringAsync: async (_algorithm, value) =>
    (await import('node:crypto')).createHash('sha256').update(value).digest('hex')
}))
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }))
vi.mock('expo-web-browser', () => ({}))
vi.mock('expo-device', () => ({ deviceName: 'Fixture phone' }))
vi.mock('expo-image-picker', () => ({}))
vi.mock('expo-document-picker', () => ({}))
vi.mock('expo-file-system', () => ({ File: class {} }))
vi.mock('expo-notifications', () => ({
  getPermissionsAsync: async () => ({ granted: true }),
  requestPermissionsAsync: async () => ({ granted: true }),
  getDevicePushTokenAsync: async () => ({ type: 'ios', data: 'local-pairing-fixture-token' })
}))
const cleanup = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
  native.plain.clear()
  native.secure.clear()
})
async function wait(check) {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 6000, interval: 10 })
}
function service(auth, owner) {
  return new BetaServices(
    auth,
    owner.kv,
    owner.credentials,
    new Drafts(owner.kv),
    'development',
    owner.cleanupCredentials,
    owner.assertCurrentAccount,
    owner.pushWork
  )
}
async function setup() {
  const provider = await startOidcProvider({
    user: { sub: 'A', name: 'A', email: 'a@example.test', email_verified: true }
  })
  cleanup.push(() => provider.close())
  const realFetch = globalThis.fetch
  const auth = new HubSignIn({
    issuer: provider.issuer,
    secureStore: new MemorySecureStore(),
    fetch: realFetch,
    crypto: {
      randomBytes: (n) => new Uint8Array(randomBytes(n)),
      sha256: async (data) => new Uint8Array(createHash('sha256').update(data).digest())
    },
    openAuthSession: async (url) =>
      (await realFetch(url, { redirect: 'manual' })).headers.get('location')
  })
  await auth.signIn()
  const owner = await nativeOwnerStores(auth),
    beta = service(auth, owner),
    storage = memoryDeviceStorage()
  const other = new DeviceStore(storage).create({
    name: 'Other phone',
    platform: 'ios',
    appVersion: 'fixture'
  })
  const server = await startEmbedded({
    ports: {
      sessions: new FakeSource(aSession('fixture-session')),
      devices: {
        storage,
        owner: () => 'A',
        issuer: provider.issuer,
        serverName: () => 'Old fixture Mac'
      }
    }
  })
  cleanup.push(() => server.stop())
  await owner.kv.setItem('relay-url', server.url)
  await beta.drafts.set('late-machine', 'fixture-session', 'returning A draft')
  const bNamespace = await nativeOwnerStores({
    status: () => ({ issuer: provider.issuer, account: { subject: 'B' } }),
    guardAccount: () => () => {}
  })
  await bNamespace.kv.setItem('fixture-other-owner', 'untouched')
  const oldMachine = {
    id: 'late-machine',
    name: 'Old Mac',
    baseUrl: server.url,
    pushUrl: server.url + '/push',
    platform: 'macos',
    version: 'fixture',
    online: true,
    lastSeen: 1
  }
  return { provider, auth, owner, beta, storage, other, server, realFetch, oldMachine, bNamespace }
}
async function askAndApprove(world, cancelled = () => false) {
  let ticket
  const pending = world.beta.pair(
    world.oldMachine,
    (state) => {
      if (state.kind === 'waiting') ticket = state.pairingId
    },
    cancelled
  )
  await wait(() => typeof ticket === 'string')
  const approved = await world.realFetch(world.server.url + '/devices/approve', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + world.server.token, 'content-type': 'application/json' },
    body: JSON.stringify({ pairingId: ticket })
  })
  expect(approved.status).toBe(200)
  return { pending }
}
for (const cancelScreen of [true, false])
  it(`refuses late old-road approval after relay change with screen cancellation=${cancelScreen}`, async () => {
    const w = await setup()
    let release,
      held = false,
      cancelled = false,
      issuedBearer
    let newRoadRequests = 0,
      forwardedOldBearer = false
    const directory = createServer((req, res) => {
      newRoadRequests++
      forwardedOldBearer ||=
        typeof issuedBearer === 'string' && req.headers.authorization === 'Bearer ' + issuedBearer
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('[]')
    })
    await new Promise((resolve) => directory.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise((resolve) => directory.close(resolve)))
    const newRoad = 'http://127.0.0.1:' + directory.address().port
    vi.stubGlobal('fetch', async (url, init) => {
      const response = await w.realFetch(url, init)
      if (String(url).startsWith(w.server.url + '/devices/pair?id=')) {
        const result = await response.clone().json()
        if (result.status === 'approved') {
          issuedBearer = result.deviceSession.token
          held = true
          await new Promise((resolve) => {
            release = resolve
          })
        }
      }
      return response
    })
    const { pending } = await askAndApprove(w, () => cancelled)
    await wait(() => held)
    cancelled = cancelScreen
    try {
      await w.beta.setRelayUrl(newRoad)
    } finally {
      release()
    }
    const result = await pending
    const late = await w.owner.credentials.get(w.oldMachine.id)
    if (late) {
      class NoSocket {
        send() {
          return undefined
        }
        close() {
          return undefined
        }
      }
      const listed = {
        ...w.oldMachine,
        baseUrl: newRoad + '/m/late-machine',
        pushUrl: newRoad + '/m/late-machine/push'
      }
      const store = createStore({
        credentials: w.owner.credentials,
        kv: w.owner.kv,
        drafts: w.beta.drafts,
        sources: { relay: { list: async () => [listed] }, developer: null },
        build: 'development',
        clientName: 'fixture',
        pushOptions: { WebSocket: NoSocket, build: 'development' }
      })
      try {
        await store.getState().loadMachines()
        const connection = await store.getState().connect(listed.id)
        await connection.client.sessions.list()
      } finally {
        store.getState().disconnectAll()
      }
    }
    const returning = await nativeOwnerStores(w.auth)
    await service(w.auth, returning).syncPushTokens()
    expect(result.kind).toBe('cancelled')
    expect(late === null).toBe(true)
    expect((await w.beta.records.list()).length).toBe(0)
    expect(newRoadRequests).toBe(0)
    expect(forwardedOldBearer).toBe(false)
    expect(new DeviceStore(w.storage).pushTargets().length).toBe(0)
    expect(
      (await new DeviceStore(w.storage).list()).some((device) => device.id === w.other.device.id)
    ).toBe(true)
    expect(await w.beta.drafts.get('late-machine', 'fixture-session')).toBe('returning A draft')
    expect(await w.bNamespace.kv.getItem('fixture-other-owner')).toBe('untouched')
  }, 15000)

it('keeps relay reset behind an approval commit already writing protected storage', async () => {
  const w = await setup()
  let release,
    writing = false
  const original = w.owner.credentials.set.bind(w.owner.credentials)
  vi.spyOn(w.owner.credentials, 'set').mockImplementationOnce(async (id, credential) => {
    writing = true
    await new Promise((resolve) => {
      release = resolve
    })
    await original(id, credential)
  })
  const { pending } = await askAndApprove(w)
  await wait(() => writing)
  let resetFinished = false
  const reset = w.beta.setRelayUrl('http://127.0.0.1:8789').then((result) => {
    resetFinished = true
    return result
  })
  await new Promise((resolve) => setImmediate(resolve))
  const earlyReset = resetFinished
  release()
  await Promise.all([pending, reset])
  expect(earlyReset).toBe(false)
  expect(await w.owner.credentials.get(w.oldMachine.id)).toBeNull()
  expect((await w.beta.records.list()).length).toBe(0)
  expect(await w.beta.drafts.get('late-machine', 'fixture-session')).toBe('returning A draft')
  expect(await w.bNamespace.kv.getItem('fixture-other-owner')).toBe('untouched')
}, 15000)

it('rolls back a protected pairing write when its screen is cancelled during persistence', async () => {
  const w = await setup()
  let release,
    writing = false,
    cancelled = false
  const original = w.owner.credentials.set.bind(w.owner.credentials)
  vi.spyOn(w.owner.credentials, 'set').mockImplementationOnce(async (id, credential) => {
    writing = true
    await new Promise((resolve) => {
      release = resolve
    })
    await original(id, credential)
  })
  const { pending } = await askAndApprove(w, () => cancelled)
  await wait(() => writing)
  cancelled = true
  release()
  expect((await pending).kind).toBe('cancelled')
  expect(await w.owner.credentials.get(w.oldMachine.id)).toBeNull()
  expect((await w.beta.records.list()).length).toBe(0)
  expect(await w.beta.drafts.get('late-machine', 'fixture-session')).toBe('returning A draft')
  expect(await w.bNamespace.kv.getItem('fixture-other-owner')).toBe('untouched')
}, 15000)

it('waits for earlier native-owner token work before committing another approved pairing', async () => {
  const w = await setup()
  const prior = new DeviceStore(w.storage).create({
    name: 'Earlier own phone',
    platform: 'ios',
    appVersion: 'fixture'
  })
  await w.owner.credentials.set('prior-machine', { serverUrl: w.server.url, bearer: prior.token })
  await w.beta.records.set({
    machineId: 'prior-machine',
    deviceId: prior.device.id,
    serverId: w.server.serverId,
    serverName: 'Earlier machine',
    pairedAt: 1
  })
  let release,
    held = false,
    approvedPoll = false,
    lateWrites = 0
  vi.stubGlobal('fetch', async (url, init) => {
    if (
      String(url) === w.server.url + '/devices/me/push-token' &&
      init.headers.Authorization === 'Bearer ' + prior.token
    ) {
      held = true
      await new Promise((resolve) => {
        release = resolve
      })
    }
    const response = await w.realFetch(url, init)
    if (String(url).startsWith(w.server.url + '/devices/pair?id=')) {
      const read = await response.clone().json()
      if (read.status === 'approved') approvedPoll = true
    }
    return response
  })
  const rotation = w.beta.registerPush('prior-machine')
  await wait(() => held)
  const returningOwner = await nativeOwnerStores(w.auth)
  const returning = service(w.auth, returningOwner)
  const original = returningOwner.credentials.set.bind(returningOwner.credentials)
  vi.spyOn(returningOwner.credentials, 'set').mockImplementation(async (id, credential) => {
    if (id === w.oldMachine.id) lateWrites++
    return original(id, credential)
  })
  const { pending } = await askAndApprove({ ...w, beta: returning })
  await wait(() => approvedPoll)
  await new Promise((resolve) => setImmediate(resolve))
  const prematureWrites = lateWrites
  const prematureRecord = (await returning.records.list()).some(
    (record) => record.machineId === w.oldMachine.id
  )
  release()
  await rotation
  expect((await pending).kind).toBe('approved')
  expect(prematureWrites).toBe(0)
  expect(prematureRecord).toBe(false)
  expect(lateWrites).toBe(1)
  expect(
    (await returning.records.list()).some((record) => record.machineId === w.oldMachine.id)
  ).toBe(true)
  expect(await w.beta.drafts.get('late-machine', 'fixture-session')).toBe('returning A draft')
  expect(await w.bNamespace.kv.getItem('fixture-other-owner')).toBe('untouched')
  expect(new DeviceStore(w.storage).list().some((device) => device.id === w.other.device.id)).toBe(
    true
  )
}, 15000)
