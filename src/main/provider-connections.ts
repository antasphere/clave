import { randomUUID } from 'crypto'
import {
  connectionServes,
  providerCompany,
  type ProviderCompanyId,
  type ProviderEndpoint,
  type ProviderWireFormat
} from '@clave/contract/settings/provider-catalogue'
import type { ProviderConnectionView } from '@clave/contract/settings/connections'
import { lazySettingsPorts, type SettingsPorts } from './ports/registry'
import { readJson, writeJson } from './ports/storage'
// ── Lane B (harness wave): provider connections ──
import { HARNESSES } from '../shared/harness'

/**
 * The provider connections of a machine (PRDCT-4426), owned by the process
 * that holds the machine's settings. A connection is a key stored once for
 * a company of the catalogue (`@clave/contract/settings`, `connections.ts`),
 * a local Ollama, or a generic endpoint, and the open harnesses (Pi,
 * OpenCode) run on it through the wire formats its endpoints speak.
 *
 * Same shape as the Claude accounts (`claude-accounts.ts`): the list
 * (`provider-connections.json`) is public and crosses to every client; the
 * keys live apart in `provider-connections-credentials.json` as the opaque
 * strings the secret port hands back (`ports/secrets.ts`), and NEVER leave
 * this process: a client sees `hasKey`, the spawn step reads the value at
 * the moment it builds the environment (`openKey`), and nothing else does.
 */
export type ProviderConnection = ProviderConnectionView

export const PROVIDER_CONNECTIONS_FILE = 'provider-connections.json'
export const PROVIDER_CONNECTIONS_CREDENTIALS_FILE = 'provider-connections-credentials.json'

interface StoredConnection {
  id: string
  label: string
  company: ProviderCompanyId
  endpoints: ProviderEndpoint[]
  needsKey: boolean
  createdAt: number
}

interface ConnectionsFile {
  v: 1
  connections: StoredConnection[]
}

interface StoredCredential {
  apiKey: string
  setAt: number
}

interface CredentialsFile {
  [connectionId: string]: StoredCredential
}

const WIRE_FORMATS: readonly string[] = ['anthropic-messages', 'openai-chat', 'openai-responses']

/** A stored connection as far as it is well formed; anything else is dropped. */
function readStoredConnection(value: unknown): StoredConnection | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || v.id.length === 0) return null
  if (typeof v.label !== 'string' || typeof v.company !== 'string') return null
  let company: ProviderCompanyId
  try {
    company = providerCompany(v.company as ProviderCompanyId).id
  } catch {
    return null
  }
  const endpoints = Array.isArray(v.endpoints)
    ? v.endpoints.filter(
        (e): e is ProviderEndpoint =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as ProviderEndpoint).baseUrl === 'string' &&
          WIRE_FORMATS.includes((e as ProviderEndpoint).wireFormat)
      )
    : []
  return {
    id: v.id,
    label: v.label,
    company,
    endpoints: endpoints.map((e) => ({ wireFormat: e.wireFormat, baseUrl: e.baseUrl })),
    needsKey: typeof v.needsKey === 'boolean' ? v.needsKey : providerCompany(company).needsKey,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0
  }
}

/** A base URL the person typed: an http(s) URL, or a refusal in their words. */
function checkedBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('The base URL must start with http:// or https://')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The base URL must start with http:// or https://')
  }
  return trimmed
}

/** The company's name, then "<name> 2", "<name> 3", … among the labels taken
 *  (the rule of the renderer's `nextConnectionLabel`, re-implemented here). */
function nextLabel(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((label) => label.trim().toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const label = `${base} ${n}`
    if (!used.has(label.toLowerCase())) return label
  }
}

type ChangeListener = (connections: ProviderConnection[]) => void

export class ProviderConnectionsManager {
  private connections: StoredConnection[] | null = null
  private credentials: CredentialsFile | null = null
  private listeners = new Set<ChangeListener>()

  constructor(private readonly ports: SettingsPorts = lazySettingsPorts) {}

  // Lazy on purpose: the ports are resolved on first use, never at import, so
  // a `--user-data-dir` override set at boot is honoured.
  private loadConnections(): StoredConnection[] {
    if (this.connections) return this.connections
    const file = readJson(
      this.ports.storage,
      PROVIDER_CONNECTIONS_FILE
    ) as Partial<ConnectionsFile> | null
    const raw = file && Array.isArray(file.connections) ? file.connections : []
    this.connections = raw
      .map(readStoredConnection)
      .filter((c): c is StoredConnection => c !== null)
    return this.connections
  }

  private saveConnections(): void {
    const file: ConnectionsFile = { v: 1, connections: this.connections ?? [] }
    writeJson(this.ports.storage, PROVIDER_CONNECTIONS_FILE, file, { mode: 0o600 })
  }

  private loadCredentials(): CredentialsFile {
    if (this.credentials) return this.credentials
    const parsed = readJson(this.ports.storage, PROVIDER_CONNECTIONS_CREDENTIALS_FILE)
    this.credentials = parsed && typeof parsed === 'object' ? (parsed as CredentialsFile) : {}
    return this.credentials
  }

  private saveCredentials(): void {
    writeJson(this.ports.storage, PROVIDER_CONNECTIONS_CREDENTIALS_FILE, this.credentials ?? {}, {
      mode: 0o600
    })
  }

  private emit(): void {
    const list = this.list()
    for (const listener of this.listeners) listener(list)
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private view(stored: StoredConnection): ProviderConnection {
    const credential = this.loadCredentials()[stored.id]
    const hasKey = typeof credential?.apiKey === 'string'
    return {
      id: stored.id,
      label: stored.label,
      company: stored.company,
      kind: 'key',
      pool: stored.company,
      endpoints: stored.endpoints.map((e) => ({ wireFormat: e.wireFormat, baseUrl: e.baseUrl })),
      needsKey: stored.needsKey,
      hasKey,
      keySetAt: hasKey && typeof credential.setAt === 'number' ? credential.setAt : null,
      createdAt: stored.createdAt
    }
  }

  /** Every connection, in the order added. Never carries a key. */
  list(): ProviderConnection[] {
    return this.loadConnections().map((c) => this.view(c))
  }

  get(id: string | undefined): ProviderConnection | undefined {
    if (!id) return undefined
    const stored = this.loadConnections().find((c) => c.id === id)
    return stored ? this.view(stored) : undefined
  }

  add(input: {
    company: ProviderCompanyId
    label?: string
    baseUrl?: string
    wireFormat?: ProviderWireFormat
  }): ProviderConnection {
    const company = providerCompany(input.company)
    let endpoints: ProviderEndpoint[] = company.endpoints.map((e) => ({ ...e }))
    if (company.id === 'generic') {
      if (!input.baseUrl?.trim() || !input.wireFormat) {
        throw new Error('Give the base URL and the wire format of the provider.')
      }
      if (!WIRE_FORMATS.includes(input.wireFormat)) {
        throw new Error('Give the base URL and the wire format of the provider.')
      }
      endpoints = [{ wireFormat: input.wireFormat, baseUrl: checkedBaseUrl(input.baseUrl) }]
    } else if (company.takesBaseUrl && input.baseUrl !== undefined && input.baseUrl.trim()) {
      const baseUrl = checkedBaseUrl(input.baseUrl)
      endpoints = endpoints.map((e) => ({ ...e, baseUrl }))
    }
    const connections = this.loadConnections()
    const label =
      input.label?.trim() ||
      nextLabel(
        company.name,
        connections.filter((c) => c.company === company.id).map((c) => c.label)
      )
    const stored: StoredConnection = {
      id: randomUUID(),
      label,
      company: company.id,
      endpoints,
      needsKey: company.needsKey,
      createdAt: Date.now()
    }
    connections.push(stored)
    this.saveConnections()
    this.emit()
    return this.view(stored)
  }

  rename(id: string, label: string): ProviderConnection | undefined {
    const stored = this.loadConnections().find((c) => c.id === id)
    if (!stored) return undefined
    stored.label = label.trim() || stored.label
    this.saveConnections()
    this.emit()
    return this.view(stored)
  }

  /** Removing a connection forgets its key with it. */
  async remove(id: string): Promise<boolean> {
    const connections = this.loadConnections()
    if (!connections.some((c) => c.id === id)) return false
    const credentials = this.loadCredentials()
    // Discard first, while the connection is still listed: a discard that
    // fails (a locked Keychain) leaves the connection and its key in place
    // and surfaces the error, rather than an orphan key nobody can reach.
    const sealed = credentials[id]?.apiKey
    if (typeof sealed === 'string') await this.ports.secrets.discard(sealed)
    // Found again after the await: the list may have moved meanwhile.
    const index = connections.findIndex((c) => c.id === id)
    if (index !== -1) connections.splice(index, 1)
    delete credentials[id]
    this.saveConnections()
    this.saveCredentials()
    this.emit()
    return true
  }

  /** Store a pasted key, sealed by the secret port. Throws when there is no
   *  key, when the connection takes none, or when the port cannot seal
   *  (never falls back to plaintext). */
  async setKey(id: string, apiKey: string): Promise<ProviderConnection> {
    const trimmed = apiKey.trim()
    const stored = this.loadConnections().find((c) => c.id === id)
    if (!stored) throw new Error('Unknown provider connection')
    if (!stored.needsKey) throw new Error(`${providerCompany(stored.company).name} takes no key.`)
    if (!trimmed) throw new Error('Paste the key first.')
    if (!(await this.ports.secrets.available())) {
      throw new Error('OS encryption is unavailable here, so the key cannot be stored securely.')
    }
    const credentials = this.loadCredentials()
    // Seal first, forget the old one after: a seal that fails (a locked
    // keychain, a denied prompt) must leave the working key in place.
    const sealed = await this.ports.secrets.seal(trimmed)
    // Checked again after the await: a remove that landed while the seal
    // waited (a Keychain prompt can take seconds) has already forgotten the
    // connection, so the new seal is discarded and nothing is written.
    if (!this.loadConnections().some((c) => c.id === id)) {
      await this.ports.secrets.discard(sealed)
      throw new Error('No such connection.')
    }
    const previous = credentials[id]
    credentials[id] = { apiKey: sealed, setAt: Date.now() }
    try {
      this.saveCredentials()
    } catch (error) {
      // The file still names the old value: the cache goes back to it, and
      // the item just sealed is forgotten rather than left orphaned.
      if (previous) credentials[id] = previous
      else delete credentials[id]
      await this.ports.secrets.discard(sealed)
      throw error
    }
    if (typeof previous?.apiKey === 'string') await this.ports.secrets.discard(previous.apiKey)
    this.emit()
    return this.view(stored)
  }

  hasKey(id: string | undefined): boolean {
    if (!id) return false
    return typeof this.loadCredentials()[id]?.apiKey === 'string'
  }

  /** Main process only: the key in clear, for the spawn step. Never logged,
   *  never sent to a renderer or a client. Undefined without one, or when
   *  the port cannot open it here. */
  async openKey(id: string | undefined): Promise<string | undefined> {
    if (!id) return undefined
    if (!this.loadConnections().some((c) => c.id === id)) return undefined
    const sealed = this.loadCredentials()[id]?.apiKey
    if (typeof sealed !== 'string') return undefined
    return this.ports.secrets.open(sealed)
  }

  /** The connections that serve the wire formats given (contract
   *  `connectionServes`). */
  serving(formats: readonly ProviderWireFormat[]): ProviderConnection[] {
    return this.list().filter((c) => connectionServes(c, formats))
  }

  // ── Lane B (harness wave): provider connections ──
  /** The connections that serve a harness, through the wire formats its row
   *  of the harness table speaks. */
  forHarness(harnessId: string): ProviderConnection[] {
    const harness = HARNESSES.find((h) => h.id === harnessId)
    return harness ? this.serving(harness.wireFormats) : []
  }
}

export const providerConnectionsManager = new ProviderConnectionsManager()
