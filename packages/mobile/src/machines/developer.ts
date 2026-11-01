/**
 * The developer's machines: a server reached by the address and the token
 * a developer pasted, to work against a local standalone server. Present
 * in a development build only (`__DEV__`; the navigator loads the screen
 * under that flag and the release-bundle check proves its absence). The
 * list lives in the key-value store, the token in the credential store.
 */
import type { ClaveServerClientOptions } from '../api/client'
import { ClaveServerClient } from '../api/client'
import type { KeyValueStore } from '../chat/drafts'
import type { CredentialStore, Machine, MachineSource } from './types'

const LIST_KEY = 'clave.developer-machines'

export interface DeveloperMachineRecord {
  readonly id: string
  readonly name: string
  readonly serverUrl: string
  readonly addedAt: number
}

export const developerMachineId = (serverUrl: string): string => {
  // A stable id per address: the host and port, safe for a secure-store key.
  const url = new URL(serverUrl)
  return `dev:${url.host.replace(/[^A-Za-z0-9.:-]/g, '-')}`
}

export class DeveloperMachineSource implements MachineSource {
  constructor(
    private readonly store: KeyValueStore,
    private readonly credentials: CredentialStore
  ) {}

  async records(): Promise<DeveloperMachineRecord[]> {
    const raw = await this.store.getItem(LIST_KEY)
    if (!raw) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed)
        ? parsed.filter(
            (r): r is DeveloperMachineRecord =>
              typeof r === 'object' &&
              r !== null &&
              typeof (r as DeveloperMachineRecord).id === 'string' &&
              typeof (r as DeveloperMachineRecord).serverUrl === 'string'
          )
        : []
    } catch {
      return []
    }
  }

  async list(): Promise<Machine[]> {
    const records = await this.records()
    return records.map((r) => ({
      id: r.id,
      name: r.name,
      platform: 'unknown' as const,
      version: '',
      online: true,
      lastSeen: null,
      baseUrl: r.serverUrl,
      pushUrl: `${r.serverUrl.replace(/\/+$/, '')}/push`
    }))
  }

  /**
   * Adds a server: the token is tried once against `GET /launch-profiles`
   * (a 401 is the server refusing it), then kept in the credential store
   * under the machine's id, the address in the list. Answers the machine.
   */
  async add(
    serverUrl: string,
    token: string,
    name = 'Developer machine',
    clientOptions: ClaveServerClientOptions = {}
  ): Promise<Machine> {
    const normalized = normalizeServerUrl(serverUrl)
    // A development build's allowance, and only that: plain http to the loopback.
    const client = new ClaveServerClient(
      { serverUrl: normalized, bearer: token },
      { build: 'development', ...clientOptions }
    )
    await client.launchProfiles.list()
    const id = developerMachineId(normalized)
    const records = (await this.records()).filter((r) => r.id !== id)
    records.push({ id, name, serverUrl: normalized, addedAt: Date.now() })
    await this.store.setItem(LIST_KEY, JSON.stringify(records))
    await this.credentials.set(id, { serverUrl: normalized, bearer: token })
    return {
      id,
      name,
      platform: 'unknown',
      version: '',
      online: true,
      lastSeen: null,
      baseUrl: normalized,
      pushUrl: `${normalized}/push`
    }
  }

  async remove(id: string): Promise<void> {
    const records = (await this.records()).filter((r) => r.id !== id)
    await this.store.setItem(LIST_KEY, JSON.stringify(records))
    await this.credentials.remove(id)
  }
}

/** `http://127.0.0.1:43201/` and `127.0.0.1:43201` both become `http://127.0.0.1:43201`. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim()
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  const url = new URL(withScheme)
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('The address must start with http:// or https://')
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}
