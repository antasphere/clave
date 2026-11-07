/**
 * The credential store over the phone's secure store (expo-secure-store on
 * the phone, a Map in the tests): one entry per machine id, the credential
 * as JSON, plus which machine is the main one. Nothing here is ever logged.
 */
import type { Credential, CredentialStore } from './types'

/** The subset of expo-secure-store the store uses. */
export interface SecureStorePort {
  getItemAsync(key: string): Promise<string | null>
  setItemAsync(key: string, value: string): Promise<void>
  deleteItemAsync(key: string): Promise<void>
}

const credentialKey = (machineId: string): string =>
  // expo-secure-store accepts [A-Za-z0-9._-] in a key: the id is encoded.
  `clave.credential.${encodeURIComponent(machineId).replace(/%/g, '_')}`
const MAIN_KEY = 'clave.main-machine'

export class SecureCredentialStore implements CredentialStore {
  constructor(private readonly secure: SecureStorePort) {}

  async get(machineId: string): Promise<Credential | null> {
    const raw = await this.secure.getItemAsync(credentialKey(machineId))
    if (!raw) return null
    try {
      const parsed: unknown = JSON.parse(raw)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as Credential).serverUrl === 'string' &&
        typeof (parsed as Credential).bearer === 'string'
      )
        return {
          serverUrl: (parsed as Credential).serverUrl,
          bearer: (parsed as Credential).bearer
        }
    } catch {
      /* an unreadable entry is no credential */
    }
    return null
  }

  async set(machineId: string, credential: Credential): Promise<void> {
    await this.secure.setItemAsync(
      credentialKey(machineId),
      JSON.stringify({ serverUrl: credential.serverUrl, bearer: credential.bearer })
    )
    if ((await this.mainMachineId()) === null) await this.setMainMachineId(machineId)
  }

  async remove(machineId: string): Promise<void> {
    await this.secure.deleteItemAsync(credentialKey(machineId))
    if ((await this.mainMachineId()) === machineId) await this.setMainMachineId(null)
  }

  async mainMachineId(): Promise<string | null> {
    return (await this.secure.getItemAsync(MAIN_KEY)) || null
  }

  async setMainMachineId(machineId: string | null): Promise<void> {
    if (machineId === null) await this.secure.deleteItemAsync(MAIN_KEY)
    else await this.secure.setItemAsync(MAIN_KEY, machineId)
  }
}

export class MemorySecureStore implements SecureStorePort {
  readonly map = new Map<string, string>()
  async getItemAsync(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async setItemAsync(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async deleteItemAsync(key: string): Promise<void> {
    this.map.delete(key)
  }
}
