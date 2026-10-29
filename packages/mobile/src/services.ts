/**
 * The platform behind the store: AsyncStorage for the drafts and the
 * navigation state, expo-secure-store for the credentials, the platform's
 * fetch and WebSocket (the defaults of the clients). The developer source
 * exists in a development build only: its module is required under
 * `__DEV__`, so a release bundle carries neither it nor the screen
 * (`scripts/check-release-bundle.mjs` proves that on the exported bundle).
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { Drafts, type KeyValueStore } from './chat/drafts'
import { SecureCredentialStore } from './machines/credentials'
import type { DeveloperMachineSource } from './machines/developer'
import type { Services } from './state/store'
import type { BuildKind } from './machines/transport-policy'

export function createServices(): Services {
  const kv: KeyValueStore = {
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    removeItem: (key) => AsyncStorage.removeItem(key)
  }
  const credentials = new SecureCredentialStore({
    getItemAsync: (key) => SecureStore.getItemAsync(key),
    setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
    deleteItemAsync: (key) => SecureStore.deleteItemAsync(key)
  })
  /* eslint-disable @typescript-eslint/no-require-imports -- a static import would put the module in every build */
  const developer: DeveloperMachineSource | null = __DEV__
    ? new (
        require('./machines/developer') as typeof import('./machines/developer')
      ).DeveloperMachineSource(kv, credentials)
    : null
  /* eslint-enable @typescript-eslint/no-require-imports */
  const build: BuildKind = __DEV__ ? 'development' : 'release'
  return {
    build,
    credentials,
    sources: { relay: null, developer },
    kv,
    drafts: new Drafts(kv),
    clientOptions: { build },
    pushOptions: { build },
    clientName: `clave-mobile/${Platform.OS}`
  }
}
