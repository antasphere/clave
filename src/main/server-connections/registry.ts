import { randomUUID } from 'node:crypto'
import {
  LOCAL_SERVER_ID,
  type SaveServerConnection,
  type SavedServerConnection
} from '../../../packages/contract/src/fleet'
import type { Endpoint } from '../../../packages/client/src/router'
import type { SettingsPorts } from '../ports/registry'

const DOCUMENT = 'server-connections.json'
const MAX_CONNECTIONS = 64
interface StoredConnection extends SavedServerConnection {
  readonly credentialRef: string
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  // eslint-disable-next-line no-control-regex -- reject control characters in saved metadata and tokens
  !/[\x00-\x1f\x7f]/.test(value)
const validId = (id: unknown): id is string => text(id, 200) && id !== LOCAL_SERVER_ID

/** A base URL, never credentials, query parameters or an API-relative path. */
export function normalizeServerUrl(value: unknown): string {
  if (!text(value, 2048)) throw new Error('Enter a valid Clave server address.')
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('invalid')
    return url.origin
  } catch {
    throw new Error(
      'Enter a valid Clave server base address without credentials, path, query or fragment.'
    )
  }
}

const publicConnection = (record: StoredConnection): SavedServerConnection => ({
  id: record.id,
  name: record.name,
  url: record.url,
  enabled: record.enabled
})

/** Main owns both this document and its secrets. No public result contains a
 * credential reference. Every change persists before replacing the in-memory
 * snapshot or retiring the old credential. Reads never repair corrupt data. */
export class ServerConnectionRegistry {
  private records: StoredConnection[] | undefined

  constructor(
    private readonly ports: SettingsPorts,
    private readonly id: () => string = () => `server-${randomUUID()}`
  ) {}

  list(): SavedServerConnection[] {
    return this.load().map(publicConnection)
  }

  save(input: SaveServerConnection): SavedServerConnection {
    if (!object(input) || !text(input.name, 120) || !input.name.trim())
      throw new Error('Enter a server name of at most 120 characters.')
    const url = normalizeServerUrl(input.url)
    const records = this.load()
    const old = input.id === undefined ? undefined : this.find(input.id)
    if (!old && records.length >= MAX_CONNECTIONS)
      throw new Error('Too many saved server connections.')
    if (input.token !== undefined && !text(input.token, 8192))
      throw new Error('Enter a valid bearer token of at most 8192 characters.')
    if (!old && input.token === undefined) throw new Error('A bearer token is required.')
    let sealed: string | undefined
    if (input.token !== undefined) {
      try {
        if (!this.ports.secrets.available()) throw new Error('unavailable')
        sealed = this.ports.secrets.seal(input.token)
        if (!text(sealed, 65536) || sealed === input.token) throw new Error('not sealed')
      } catch {
        throw new Error('Secure credential storage is unavailable. The connection was not saved.')
      }
    }
    const id = old?.id ?? this.id()
    if (!validId(id) || (!old && records.some((record) => record.id === id))) {
      if (sealed) this.discard(sealed)
      throw new Error('Could not allocate a server connection identity.')
    }
    const record: StoredConnection = {
      id,
      name: input.name.trim(),
      url,
      enabled: old?.enabled ?? true,
      credentialRef: sealed ?? old!.credentialRef
    }
    const next = old
      ? records.map((value) => (value.id === id ? record : value))
      : [...records, record]
    try {
      this.persist(next)
    } catch (error) {
      if (sealed) this.discard(sealed)
      throw error
    }
    if (sealed && old) this.discard(old.credentialRef)
    return publicConnection(record)
  }

  connect(id: string): SavedServerConnection {
    return this.setEnabled(id, true)
  }

  disconnect(id: string): SavedServerConnection {
    return this.setEnabled(id, false)
  }

  remove(id: string): void {
    const record = this.find(id)
    this.persist(this.load().filter((value) => value.id !== id))
    this.discard(record.credentialRef)
  }

  /** Privileged IPC only. The preload must never expose this to renderer. */
  endpoint(id: string): Endpoint {
    const record = this.find(id)
    if (!record.enabled) throw new Error('This server connection is disconnected.')
    let token: string | undefined
    try {
      token = this.ports.secrets.open(record.credentialRef)
    } catch {
      // Adapter errors may include secret material. Return only our safe error.
    }
    if (!text(token, 8192))
      throw new Error('The saved server credential is unavailable. Enter its token again.')
    return { url: record.url, token }
  }

  private find(id: unknown): StoredConnection {
    const record = validId(id) ? this.load().find((value) => value.id === id) : undefined
    if (!record) throw new Error('Unknown server connection.')
    return record
  }

  private setEnabled(id: string, enabled: boolean): SavedServerConnection {
    const record = { ...this.find(id), enabled }
    this.persist(this.load().map((value) => (value.id === id ? record : value)))
    return publicConnection(record)
  }

  private persist(records: StoredConnection[]): void {
    try {
      this.ports.storage.write(DOCUMENT, JSON.stringify({ v: 1, connections: records }, null, 2), {
        mode: 0o600
      })
    } catch {
      throw new Error('Could not save server connections. Previous settings were retained.')
    }
    this.records = records
  }

  private discard(ref: string): void {
    try {
      this.ports.secrets.discard(ref)
    } catch {
      // The committed document remains authoritative. Never undo a committed
      // rotation or expose an adapter error after the public operation succeeds.
    }
  }

  private load(): StoredConnection[] {
    if (this.records) return this.records
    const source = this.ports.storage.read(DOCUMENT)
    if (source === null) return (this.records = [])
    try {
      const data: unknown = JSON.parse(source)
      if (
        !object(data) ||
        data.v !== 1 ||
        !Array.isArray(data.connections) ||
        data.connections.length > MAX_CONNECTIONS
      )
        throw new Error('shape')
      const ids = new Set<string>()
      const records = data.connections.map((value: unknown): StoredConnection => {
        if (
          !object(value) ||
          !validId(value.id) ||
          ids.has(value.id) ||
          !text(value.name, 120) ||
          !value.name.trim() ||
          typeof value.enabled !== 'boolean' ||
          !text(value.credentialRef, 65536)
        )
          throw new Error('record')
        ids.add(value.id)
        return {
          id: value.id,
          name: value.name,
          url: normalizeServerUrl(value.url),
          enabled: value.enabled,
          credentialRef: value.credentialRef
        }
      })
      return (this.records = records)
    } catch {
      throw new Error(
        'Saved server connections could not be read. The document was left unchanged.'
      )
    }
  }
}
