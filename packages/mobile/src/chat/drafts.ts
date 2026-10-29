/**
 * The composer's drafts, one per session per machine, kept on the device
 * until sent: through a restart of the app and through being offline, never
 * sent by themselves (decision 10 of the spec). Behind one key-value port,
 * AsyncStorage on the phone and a Map in the tests.
 */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export const draftKey = (machineId: string, sessionId: string): string =>
  `clave.draft:${machineId}:${sessionId}`

export class Drafts {
  private readonly cache = new Map<string, string>()

  constructor(private readonly store: KeyValueStore) {}

  /** The draft kept for this session, '' when none. */
  async get(machineId: string, sessionId: string): Promise<string> {
    const key = draftKey(machineId, sessionId)
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    const stored = (await this.store.getItem(key)) ?? ''
    this.cache.set(key, stored)
    return stored
  }

  /** Keeps the text; an empty text removes the draft. */
  async set(machineId: string, sessionId: string, text: string): Promise<void> {
    const key = draftKey(machineId, sessionId)
    this.cache.set(key, text)
    if (text === '') await this.store.removeItem(key)
    else await this.store.setItem(key, text)
  }

  clear(machineId: string, sessionId: string): Promise<void> {
    return this.set(machineId, sessionId, '')
  }
}

/** A store over a Map, for the tests and for a platform without storage. */
export class MemoryKeyValueStore implements KeyValueStore {
  readonly map = new Map<string, string>()
  async getItem(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async setItem(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async removeItem(key: string): Promise<void> {
    this.map.delete(key)
  }
}
