import { afterEach, expect, it, vi } from 'vitest'
import type { HubSignIn } from '../auth/sign-in'
import { PUSH_CLEANUP_KEY } from '../notifications/cleanup'

const storage = vi.hoisted(() => ({
  plain: new Map<string, string>(),
  secure: new Map<string, string>()
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.plain.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.plain.set(key, value)
    },
    removeItem: async (key: string) => {
      storage.plain.delete(key)
    }
  }
}))
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => storage.secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    storage.secure.set(key, value)
  },
  deleteItemAsync: async (key: string) => {
    storage.secure.delete(key)
  }
}))
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }))
vi.mock('expo-web-browser', () => ({}))
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'sha256' },
  digestStringAsync: async (_algorithm: string, value: string) =>
    (await import('node:crypto')).createHash('sha256').update(value).digest('hex')
}))
import { nativeOwnerStores } from './account'

afterEach(() => {
  storage.plain.clear()
  storage.secure.clear()
})
const account = (subject: string, issuer = 'https://issuer.example.test'): HubSignIn =>
  ({
    status: () => ({ issuer, account: { subject } }),
    guardAccount: () => () => {}
  }) as unknown as HubSignIn

it('shares the push lifecycle queue only across the same issuer and owner', async () => {
  const a = await nativeOwnerStores(account('A'))
  const returning = await nativeOwnerStores(account('A'))
  const b = await nativeOwnerStores(account('B'))
  const otherIssuer = await nativeOwnerStores(account('A', 'https://another.example.test'))
  expect(returning.pushWork).toBe(a.pushWork)
  expect(b.pushWork).not.toBe(a.pushWork)
  expect(otherIssuer.pushWork).not.toBe(a.pushWork)
})

it('serializes captured cleanup credentials only through the separate native secure namespace', async () => {
  const a = await nativeOwnerStores(account('A'))
  const b = await nativeOwnerStores(account('B'))
  const credential = {
    serverUrl: 'https://old-server.example.test',
    bearer: 'captured-device-fixture'
  }
  const ref = 'push-cleanup-fixture'
  await a.credentials.set('machine', credential)
  await a.cleanupCredentials.set(ref, credential)
  await a.kv.setItem(PUSH_CLEANUP_KEY, JSON.stringify({ v: 2, refs: [ref] }))
  await a.credentials.remove('machine')
  expect(await a.cleanupCredentials.get(ref)).toEqual(credential)
  expect(await b.cleanupCredentials.get(ref)).toBeNull()
  expect(await b.kv.getItem(PUSH_CLEANUP_KEY)).toBeNull()
  expect(
    [...storage.plain.values()].some(
      (value) => value.includes(credential.bearer) || value.includes(credential.serverUrl)
    )
  ).toBe(false)
  expect(
    [...storage.secure.entries()].some(
      ([key, value]) =>
        key.startsWith(a.namespace + '.push-cleanup.') && value === JSON.stringify(credential)
    )
  ).toBe(true)
})
