import { lazySettingsPorts } from './ports/registry'
import { readJson, writeJson, type StoragePort } from './ports/storage'

/**
 * The catalogue of models the launcher lists under Pi and OpenCode (PRDCT-4496),
 * read from models.dev and cached a day on disk under the settings ports
 * (`models-catalog.json`). Clave never replicates a harness's own provider list:
 * the models come from models.dev, and what models.dev does not carry (the
 * endpoints, each harness's provider id and key variable) is the overlay's
 * (`models-catalog-overlay.ts`). Romain's decision of 12 and 13 November 2026.
 */

export const MODELS_DEV_URL = 'https://models.dev/api.json'
export const MODELS_CATALOG_FILE = 'models-catalog.json'
export const MODELS_CATALOG_TTL_MS = 24 * 60 * 60_000

const FETCH_TIMEOUT_MS = 15_000

export interface CatalogModel {
  id: string
  name: string
  reasoning: boolean
  toolCall: boolean
  status?: 'deprecated' | 'beta' | 'alpha'
  contextLimit?: number
  outputLimit?: number
  releaseDate?: string
  cost?: { input?: number; output?: number }
}

export interface CatalogProvider {
  id: string
  name: string
  env: string[]
  api?: string
  npm?: string
  models: CatalogModel[]
}

export interface ModelsCatalogSnapshot {
  fetchedAt: number
  providers: CatalogProvider[]
}

export interface ModelsCatalogRead {
  snapshot: ModelsCatalogSnapshot | null
  stale: boolean
  error?: string
}

/** The sentences a failed read carries: never the service's own text. */
export const MODELS_DEV_UNREACHABLE = 'Clave could not reach models.dev.'
export const MODELS_DEV_UNREADABLE = 'models.dev answered something Clave could not read.'
const answered = (status: number): string => `models.dev answered ${status}.`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined
const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0

function pruneModel(raw: unknown): CatalogModel | null {
  if (!isRecord(raw)) return null
  const id = nonEmptyString(raw.id)
  if (!id) return null
  const model: CatalogModel = {
    id,
    name: nonEmptyString(raw.name) ?? id,
    reasoning: raw.reasoning === true,
    toolCall: raw.tool_call === true
  }
  if (raw.status === 'deprecated' || raw.status === 'beta' || raw.status === 'alpha')
    model.status = raw.status
  if (isRecord(raw.limit)) {
    const context = finiteNumber(raw.limit.context)
    const output = finiteNumber(raw.limit.output)
    if (context !== undefined) model.contextLimit = context
    if (output !== undefined) model.outputLimit = output
  }
  const releaseDate = nonEmptyString(raw.release_date)
  if (releaseDate) model.releaseDate = releaseDate
  if (isRecord(raw.cost)) {
    const input = finiteNumber(raw.cost.input)
    const output = finiteNumber(raw.cost.output)
    if (input !== undefined || output !== undefined)
      model.cost = {
        ...(input !== undefined && { input }),
        ...(output !== undefined && { output })
      }
  }
  return model
}

function pruneProvider(raw: unknown): CatalogProvider | null {
  if (!isRecord(raw)) return null
  const id = nonEmptyString(raw.id)
  if (!id) return null
  const env = Array.isArray(raw.env)
    ? raw.env.filter((v): v is string => typeof v === 'string' && v !== '')
    : []
  const models: CatalogModel[] = []
  if (isRecord(raw.models))
    for (const value of Object.values(raw.models)) {
      const model = pruneModel(value)
      if (model) models.push(model)
    }
  models.sort(byId)
  const provider: CatalogProvider = { id, name: nonEmptyString(raw.name) ?? id, env, models }
  const api = nonEmptyString(raw.api)
  const npm = nonEmptyString(raw.npm)
  if (api) provider.api = api
  if (npm) provider.npm = npm
  return provider
}

/** The parsed api.json (a map of provider id to provider record) pruned to
 *  the fields the launcher uses, providers and their models sorted by id. A
 *  malformed entry costs that entry; nothing here throws. */
export function pruneModelsDev(raw: unknown): CatalogProvider[] {
  if (!isRecord(raw)) return []
  const providers: CatalogProvider[] = []
  for (const value of Object.values(raw)) {
    const provider = pruneProvider(value)
    if (provider) providers.push(provider)
  }
  return providers.sort(byId)
}

/** The stored document read back: a snapshot only when it is well formed. */
function readSnapshot(raw: unknown): ModelsCatalogSnapshot | null {
  if (!isRecord(raw)) return null
  const fetchedAt = finiteNumber(raw.fetchedAt)
  if (fetchedAt === undefined || !Array.isArray(raw.providers)) return null
  const providers = raw.providers.filter(
    (p): p is CatalogProvider => isRecord(p) && typeof p.id === 'string' && Array.isArray(p.models)
  )
  return { fetchedAt, providers }
}

export interface ModelsCatalogDeps {
  ports?: () => { storage: StoragePort }
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

export class ModelsCatalog {
  private readonly ports: () => { storage: StoragePort }
  private readonly fetchImpl: () => typeof fetch
  private readonly now: () => number
  private readonly timeoutMs: number
  private memory: ModelsCatalogSnapshot | null = null
  /** The fetch in flight: concurrent reads share it. */
  private pending: Promise<ModelsCatalogRead> | null = null

  constructor(deps: ModelsCatalogDeps = {}) {
    this.ports = deps.ports ?? (() => lazySettingsPorts)
    // The global looked up at each call, so a stub installed later is honoured.
    const injected = deps.fetch
    this.fetchImpl = injected ? () => injected : () => fetch
    this.now = deps.now ?? Date.now
    this.timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS
  }

  private fresh(snapshot: ModelsCatalogSnapshot | null): snapshot is ModelsCatalogSnapshot {
    if (!snapshot) return false
    const age = this.now() - snapshot.fetchedAt
    return age >= 0 && age < MODELS_CATALOG_TTL_MS
  }

  private load(): ModelsCatalogSnapshot | null {
    try {
      return readSnapshot(readJson(this.ports().storage, MODELS_CATALOG_FILE))
    } catch {
      return null
    }
  }

  async read(options: { force?: boolean } = {}): Promise<ModelsCatalogRead> {
    if (!options.force) {
      if (this.fresh(this.memory)) return { snapshot: this.memory, stale: false }
      const stored = this.load()
      if (this.fresh(stored)) {
        this.memory = stored
        return { snapshot: stored, stale: false }
      }
    }
    if (!this.pending) {
      this.pending = this.refresh().finally(() => {
        this.pending = null
      })
    }
    return this.pending
  }

  /** The providers of those ids, in their order; an unknown id is omitted. */
  async providers(ids: string[]): Promise<CatalogProvider[]> {
    const { snapshot } = await this.read()
    if (!snapshot) return []
    const index = new Map(snapshot.providers.map((p) => [p.id, p]))
    return ids.flatMap((id) => {
      const provider = index.get(id)
      return provider ? [provider] : []
    })
  }

  /** A provider's models, the deprecated ones hidden; [] when it is unknown. */
  async modelsOf(providerId: string): Promise<CatalogModel[]> {
    const [provider] = await this.providers([providerId])
    return provider ? provider.models.filter((m) => m.status !== 'deprecated') : []
  }

  private async refresh(): Promise<ModelsCatalogRead> {
    let providers: CatalogProvider[]
    try {
      providers = await this.download()
    } catch (error) {
      const message = error instanceof Error ? error.message : MODELS_DEV_UNREACHABLE
      return { snapshot: this.fallback(), stale: true, error: message }
    }
    const snapshot: ModelsCatalogSnapshot = { fetchedAt: this.now(), providers }
    this.memory = snapshot
    try {
      writeJson(this.ports().storage, MODELS_CATALOG_FILE, snapshot)
    } catch (error) {
      // The catalogue is still good for this process; the next one fetches again.
      console.error('[models-catalog] could not write the cache', error)
    }
    return { snapshot, stale: false }
  }

  /** The newest snapshot this process can still show: in memory or on disk. */
  private fallback(): ModelsCatalogSnapshot | null {
    const stored = this.load()
    if (!stored) return this.memory
    if (!this.memory) return stored
    return stored.fetchedAt >= this.memory.fetchedAt ? stored : this.memory
  }

  /** GET api.json, pruned. Throws an Error whose message is one sentence for
   *  the person, never the response body. */
  private async download(): Promise<CatalogProvider[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await this.fetchImpl()(MODELS_DEV_URL, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal
      })
    } catch {
      clearTimeout(timer)
      throw new Error(MODELS_DEV_UNREACHABLE)
    }
    try {
      if (!res.ok) throw new Error(answered(res.status))
      let body: unknown
      try {
        body = await res.json()
      } catch {
        throw new Error(controller.signal.aborted ? MODELS_DEV_UNREACHABLE : MODELS_DEV_UNREADABLE)
      }
      if (!isRecord(body)) throw new Error(MODELS_DEV_UNREADABLE)
      return pruneModelsDev(body)
    } finally {
      clearTimeout(timer)
    }
  }
}

/** This process's catalogue, on its own settings ports. */
export const modelsCatalog = new ModelsCatalog()
