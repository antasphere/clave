import type { KeyValueStore } from '../chat/drafts'
import type { SecureStorePort } from '../machines/credentials'

/** An immutable owner namespace. An old asynchronous operation keeps its own
 * store after sign-out; it can never write into the next account's records. */
export function ownerKeyValueStore(store: KeyValueStore, namespace: string): KeyValueStore {
  const key = (name: string): string => `${namespace}:${name}`
  return {
    getItem: (name) => store.getItem(key(name)),
    setItem: (name, value) => store.setItem(key(name), value),
    removeItem: (name) => store.removeItem(key(name))
  }
}

export function ownerSecureStore(store: SecureStorePort, namespace: string): SecureStorePort {
  const key = (name: string): string => `${namespace}.${name}`
  return {
    getItemAsync: (name) => store.getItemAsync(key(name)),
    setItemAsync: (name, value) => store.setItemAsync(key(name), value),
    deleteItemAsync: (name) => store.deleteItemAsync(key(name))
  }
}

export async function ownerNamespace(
  issuer: string,
  subject: string | null,
  sha256: (value: string) => Promise<string>
): Promise<string> {
  return `clave.owner.${await sha256(JSON.stringify([issuer, subject === null ? null : { subject }]))}`
}
