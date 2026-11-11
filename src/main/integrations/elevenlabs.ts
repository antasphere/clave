import { lazySettingsPorts, type SettingsPorts } from '../ports/registry'
import { readJson, writeJson } from '../ports/storage'
import { TEST_NO_ACTIVATE } from '../test-mode'
import {
  DEFAULT_ELEVENLABS_MODEL,
  isElevenLabsModelId,
  type ElevenLabsModelId,
  type ElevenLabsStatus,
  type ElevenLabsVoice
} from '../../shared/elevenlabs'

/**
 * The ElevenLabs integration of a machine (PRDCT-4410): ONE API key, sealed
 * by the machine's own secret port, checked against the account it belongs
 * to, with the voice and the model the agents' speech uses. Like the
 * helpers' preference (`../helpers/preferences.ts`) it has one owner: the
 * process that holds the machine's settings (the separate server child, main
 * when the server runs in-process, the standalone server on a saved server).
 *
 * The owner keeps one JSON document under its settings ports
 * (`integrations.json`), read at every call. The document holds the SEALED
 * handle the secret port answered (an OS ciphertext in the app, a Keychain
 * handle on the standalone server), never the key: the key is in no
 * document, no log, no event and no read model. It is opened only for a
 * caller of this process (`openKey`, the speech route).
 */

export const INTEGRATIONS_FILE = 'integrations.json'
export type { ElevenLabsModelId, ElevenLabsStatus, ElevenLabsVoice } from '../../shared/elevenlabs'

/** The three ways a call to ElevenLabs fails, in the person's words. None
 *  carries the key or the service's own text. */
export const ELEVENLABS_REFUSED = 'The key was refused by ElevenLabs.'
export const ELEVENLABS_UNREACHABLE = 'The server could not reach ElevenLabs.'
export const ELEVENLABS_NO_KEY = 'No ElevenLabs key on this machine.'
const answered = (status: number): string => `ElevenLabs answered ${status}.`

const FETCH_TIMEOUT_MS = 10_000
const VOICES_CAP = 500
const VOICES_PAGE = 100

interface StoredElevenLabs {
  sealed: string
  setAt: number
  voiceId: string | null
  voiceName: string | null
  modelId: ElevenLabsModelId
  checkedAt: number | null
  tier: string | null
  charactersUsed: number | null
  charactersLimit: number | null
  lastError: string | null
}

interface StoredDocument {
  version: 1
  elevenLabs?: StoredElevenLabs
}

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** The stored entry read back as far as it is well formed: without a sealed
 *  handle there is no key, so no entry; any other bad field costs the field. */
function readEntry(raw: unknown): StoredElevenLabs | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.sealed !== 'string' || r.sealed === '') return undefined
  return {
    sealed: r.sealed,
    setAt: numberOrNull(r.setAt) ?? 0,
    voiceId: stringOrNull(r.voiceId),
    voiceName: stringOrNull(r.voiceName),
    modelId: isElevenLabsModelId(r.modelId) ? r.modelId : DEFAULT_ELEVENLABS_MODEL,
    checkedAt: numberOrNull(r.checkedAt),
    tier: stringOrNull(r.tier),
    charactersUsed: numberOrNull(r.charactersUsed),
    charactersLimit: numberOrNull(r.charactersLimit),
    lastError: stringOrNull(r.lastError)
  }
}

const NOT_CONFIGURED: ElevenLabsStatus = {
  configured: false,
  setAt: null,
  voiceId: null,
  voiceName: null,
  modelId: DEFAULT_ELEVENLABS_MODEL,
  checkedAt: null,
  tier: null,
  charactersUsed: null,
  charactersLimit: null,
  lastError: null
}

function statusOf(entry: StoredElevenLabs | undefined): ElevenLabsStatus {
  if (!entry) return { ...NOT_CONFIGURED }
  return {
    configured: true,
    setAt: entry.setAt,
    voiceId: entry.voiceId,
    voiceName: entry.voiceName,
    modelId: entry.modelId,
    checkedAt: entry.checkedAt,
    tier: entry.tier,
    charactersUsed: entry.charactersUsed,
    charactersLimit: entry.charactersLimit,
    lastError: entry.lastError
  }
}

/** A refusal with the sentence for the person: a plain `Error`, which the
 *  settings handlers answer as `SettingsRefused`. */
const refusal = (message: string): Error => new Error(message)

export const ELEVENLABS_API = 'https://api.elevenlabs.io'

/** The base URL the environment names in place of the service
 *  (`CLAVE_ELEVENLABS_BASE_URL`, read at each call: a test's stub), honoured
 *  only under the end-to-end harness (`--test-no-activate`). In any other run
 *  it is ignored, with no escape hatch: whoever can set a server's
 *  environment must not be able to send the key elsewhere. A script that
 *  speaks to another place passes its own `baseUrl`. Null when there is none
 *  to honour. */
export function elevenLabsBaseUrlOverride(
  env: NodeJS.ProcessEnv = process.env,
  testMode: boolean = TEST_NO_ACTIVATE
): string | null {
  const named = env.CLAVE_ELEVENLABS_BASE_URL?.trim()
  if (!named) return null
  return testMode ? named : null
}

/** Where ElevenLabs is: the harness's override (above), else the public API.
 *  The speech route (`../speech.ts`) speaks to the same place the store
 *  checks the key. */
export const elevenLabsBaseUrl = (): string => elevenLabsBaseUrlOverride() ?? ELEVENLABS_API

export interface ElevenLabsIntegrationOptions {
  /** Where ElevenLabs is; `elevenLabsBaseUrl` by default. */
  baseUrl?: () => string
  now?: () => number
}

export class ElevenLabsIntegration {
  private readonly listeners = new Set<(status: ElevenLabsStatus) => void>()
  private readonly baseUrl: () => string
  private readonly now: () => number
  /** The writes, one after the other: a write never interleaves with
   *  another's load and save in this process. */
  private writes: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly ports: SettingsPorts = lazySettingsPorts,
    options: ElevenLabsIntegrationOptions = {}
  ) {
    this.baseUrl = options.baseUrl ?? elevenLabsBaseUrl
    this.now = options.now ?? Date.now
  }

  private load(): StoredDocument {
    const raw = readJson(this.ports.storage, INTEGRATIONS_FILE)
    const record =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
    const elevenLabs = readEntry(record.elevenLabs)
    return { version: 1, ...(elevenLabs && { elevenLabs }) }
  }

  private save(document: StoredDocument): ElevenLabsStatus {
    writeJson(this.ports.storage, INTEGRATIONS_FILE, document)
    const status = statusOf(document.elevenLabs)
    for (const listener of [...this.listeners]) {
      try {
        listener(status)
      } catch (error) {
        console.error('[integrations] listener failed', error)
      }
    }
    return status
  }

  /** Run a write after every write before it, whatever became of them. */
  private serial<T>(write: () => T | Promise<T>): Promise<T> {
    const run = this.writes.then(write, write)
    this.writes = run.catch(() => undefined)
    return run
  }

  /** Every change, after the write, with the status (never the key). */
  onChange(listener: (status: ElevenLabsStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  status(): ElevenLabsStatus {
    return statusOf(this.load().elevenLabs)
  }

  /** Seal and store a pasted key, then check it against the account. A
   *  failed check keeps the key (a network failure must not lose a paste)
   *  and says so in `lastError`. */
  async setKey(apiKey: string): Promise<ElevenLabsStatus> {
    const trimmed = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (!trimmed) throw refusal('Paste the API key first.')
    if (!(await this.ports.secrets.available()))
      throw refusal('This machine cannot store a secret.')
    // Sealed first, the old one forgotten after: a seal that fails leaves the
    // working key in place.
    const sealed = await this.ports.secrets.seal(trimmed)
    await this.serial(async () => {
      const document = this.load()
      const previous = document.elevenLabs
      document.elevenLabs = {
        sealed,
        setAt: this.now(),
        voiceId: null,
        voiceName: null,
        modelId: previous?.modelId ?? DEFAULT_ELEVENLABS_MODEL,
        checkedAt: null,
        tier: null,
        charactersUsed: null,
        charactersLimit: null,
        lastError: null
      }
      try {
        this.save(document)
      } catch (error) {
        await this.ports.secrets.discard(sealed)
        throw error
      }
      if (previous && previous.sealed !== sealed) await this.ports.secrets.discard(previous.sealed)
    })
    return this.check()
  }

  /** Read the account the key belongs to; the outcome is stored either way,
   *  as long as the key checked is still the one stored. A Remove or a
   *  Replace while the account is asked wins: the check then writes nothing
   *  (it never writes back the entry it read before its call). */
  async check(): Promise<ElevenLabsStatus> {
    const opened = this.load().elevenLabs
    if (!opened) return statusOf(undefined)
    const { sealed } = opened
    const key = await this.open(sealed)
    const checkedAt = this.now()
    let outcome: Pick<
      StoredElevenLabs,
      'tier' | 'charactersUsed' | 'charactersLimit' | 'lastError'
    > | null = null
    let lastError: string | null
    if (!key) {
      lastError = 'The key stored on this machine could not be opened.'
    } else {
      let res: Response | null = null
      try {
        res = await this.request('/v1/user/subscription', key)
      } catch {
        res = null
      }
      if (!res) lastError = ELEVENLABS_UNREACHABLE
      else if (res.ok) {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
        outcome = {
          tier: stringOrNull(body?.tier),
          charactersUsed: numberOrNull(body?.character_count),
          charactersLimit: numberOrNull(body?.character_limit),
          lastError: null
        }
        lastError = null
      } else
        lastError =
          res.status === 401 || res.status === 403 ? ELEVENLABS_REFUSED : answered(res.status)
    }
    return this.serial(() => {
      // Read again after the call: only the check's own fields, only onto
      // the entry whose key it checked.
      const document = this.load()
      const entry = document.elevenLabs
      if (!entry || entry.sealed !== sealed) return statusOf(entry)
      if (outcome) Object.assign(entry, outcome)
      else entry.lastError = lastError
      entry.checkedAt = checkedAt
      return this.save(document)
    })
  }

  /** The voices the account can speak with, paged until the service says
   *  there are no more (500 at most). Refused in the check's words. */
  async voices(): Promise<{ voices: ElevenLabsVoice[] }> {
    const key = await this.openKey()
    if (!key) throw refusal(ELEVENLABS_NO_KEY)
    const voices: ElevenLabsVoice[] = []
    let token: string | null = null
    for (;;) {
      const query = new URLSearchParams({ page_size: String(VOICES_PAGE) })
      if (token) query.set('next_page_token', token)
      let res: Response
      try {
        res = await this.request(`/v2/voices?${query.toString()}`, key)
      } catch {
        throw refusal(ELEVENLABS_UNREACHABLE)
      }
      if (res.status === 401 || res.status === 403) throw refusal(ELEVENLABS_REFUSED)
      if (!res.ok) throw refusal(answered(res.status))
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      const page = Array.isArray(body?.voices) ? (body.voices as unknown[]) : []
      for (const raw of page) {
        const voice = readVoice(raw)
        if (voice) voices.push(voice)
        if (voices.length >= VOICES_CAP) return { voices }
      }
      const next = stringOrNull(body?.next_page_token)
      if (body?.has_more !== true || !next || next === token) return { voices }
      token = next
    }
  }

  /** Choose the voice (and, when given, the model) the agents speak with. */
  async setVoice(
    voiceId: string,
    voiceName: string,
    modelId?: ElevenLabsModelId
  ): Promise<ElevenLabsStatus> {
    return this.serial(() => {
      const document = this.load()
      const entry = document.elevenLabs
      if (!entry) throw refusal(ELEVENLABS_NO_KEY)
      if (typeof voiceId !== 'string' || typeof voiceName !== 'string')
        throw refusal('That is not a voice.')
      if (modelId !== undefined && !isElevenLabsModelId(modelId))
        throw refusal('That is not an ElevenLabs model.')
      entry.voiceId = voiceId.trim() || null
      entry.voiceName = entry.voiceId ? voiceName.trim() || null : null
      if (modelId !== undefined) entry.modelId = modelId
      return this.save(document)
    })
  }

  /** Forget the key: its sealed handle discarded, the entry gone. */
  async removeKey(): Promise<ElevenLabsStatus> {
    return this.serial(async () => {
      const document = this.load()
      const entry = document.elevenLabs
      if (!entry) return statusOf(undefined)
      delete document.elevenLabs
      const status = this.save(document)
      await this.ports.secrets.discard(entry.sealed)
      return status
    })
  }

  /** The key, for a caller of this process only (the speech route). Null
   *  when there is none or the port cannot open it here. */
  async openKey(): Promise<string | null> {
    const entry = this.load().elevenLabs
    return entry ? this.open(entry.sealed) : null
  }

  private async open(sealed: string): Promise<string | null> {
    try {
      return (await this.ports.secrets.open(sealed)) ?? null
    } catch {
      return null
    }
  }

  private async request(path: string, key: string): Promise<Response> {
    const base = this.baseUrl().replace(/\/+$/, '')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      return await fetch(`${base}${path}`, {
        headers: { 'xi-api-key': key, accept: 'application/json' },
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

function readVoice(raw: unknown): ElevenLabsVoice | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.voice_id !== 'string' || !r.voice_id) return null
  const labels: Record<string, string> = {}
  if (r.labels && typeof r.labels === 'object' && !Array.isArray(r.labels))
    for (const [k, v] of Object.entries(r.labels as Record<string, unknown>))
      if (typeof v === 'string' && v) labels[k] = v
  return {
    voiceId: r.voice_id,
    name: typeof r.name === 'string' && r.name ? r.name : r.voice_id,
    category: typeof r.category === 'string' ? r.category : '',
    labels,
    previewUrl: stringOrNull(r.preview_url)
  }
}

/** This process's integration, on its own settings ports. */
export const elevenLabsIntegration = new ElevenLabsIntegration()
