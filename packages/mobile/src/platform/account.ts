import AsyncStorage from '@react-native-async-storage/async-storage'
import Constants from 'expo-constants'
import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import * as WebBrowser from 'expo-web-browser'
import { HubSignIn } from '../auth/sign-in'
import { ownerKeyValueStore, ownerSecureStore, ownerNamespace } from '../auth/owner-storage'
import type { CryptoPort } from '../auth/pkce'
import { SecureCredentialStore } from '../machines/credentials'
import type { OwnerPushWork } from '../notifications/cleanup'

const ownerPushWork = new Map<string, OwnerPushWork>()

export const rawKeyValueStore = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
  removeItem: (key: string) => AsyncStorage.removeItem(key)
}
export const rawSecureStore = {
  getItemAsync: (key: string) => SecureStore.getItemAsync(key),
  setItemAsync: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  deleteItemAsync: (key: string) => SecureStore.deleteItemAsync(key)
}
export const nativeCrypto: CryptoPort = {
  randomBytes: (n) => Crypto.getRandomBytes(n),
  sha256: async (data) =>
    new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(data)))
}
let account: HubSignIn | null = null
export function nativeAccount(): HubSignIn {
  if (!account)
    account = new HubSignIn({
      issuer: __DEV__
        ? (process.env.EXPO_PUBLIC_CLAVE_ANTASPHERE_ISSUER ??
          (Constants.expoConfig?.extra?.antasphereIssuer as string | undefined))
        : undefined,
      secureStore: rawSecureStore,
      crypto: nativeCrypto,
      openAuthSession: async (url, redirectUri) => {
        const result = await WebBrowser.openAuthSessionAsync(url, redirectUri)
        return result.type === 'success' ? result.url : null
      }
    })
  return account
}

export async function nativeOwnerStores(auth: HubSignIn): Promise<{
  namespace: string
  assertCurrentAccount: () => void
  kv: ReturnType<typeof ownerKeyValueStore>
  credentials: SecureCredentialStore
  cleanupCredentials: SecureCredentialStore
  pushWork: OwnerPushWork
}> {
  const status = auth.status()
  const assertCurrentAccount = auth.guardAccount()
  const subject = status.account?.subject
  const namespace = await ownerNamespace(status.issuer, subject ?? null, (value) =>
    Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value)
  )
  let pushWork = ownerPushWork.get(namespace)
  if (!pushWork) {
    pushWork = { tail: Promise.resolve(), roadGeneration: 0 }
    ownerPushWork.set(namespace, pushWork)
  }
  return {
    namespace,
    assertCurrentAccount,
    pushWork,
    kv: ownerKeyValueStore(rawKeyValueStore, namespace),
    credentials: new SecureCredentialStore(ownerSecureStore(rawSecureStore, namespace)),
    cleanupCredentials: new SecureCredentialStore(
      ownerSecureStore(rawSecureStore, namespace + '.push-cleanup')
    )
  }
}
