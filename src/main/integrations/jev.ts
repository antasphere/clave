import { lazySettingsPorts, type SettingsPorts } from '../ports/registry'
import { TEST_NO_ACTIVATE } from '../test-mode'
import { JEV_REFUSED_PREFIX, type JevStatus } from '../../shared/jev'
import { readIntegrationEntry, serialIntegrations, writeIntegrationEntry } from './document'
import { cleanReason } from './elevenlabs'

/**
 * The Jev integration of a machine (PRDCT-5179): ONE API key for TypeSafe's
 * decision model, sealed by the machine's own secret port beside the
 * ElevenLabs key (`elevenlabs.ts`, whose shape this mirrors), and checked
 * against the one call that sends nothing of ours, the list of models. Like
 * the ElevenLabs key it has one owner, the process that holds the machine's
 * settings, and one entry, `jev`, in that process's `integrations.json`,
 * read and written through `document.ts` alone so neither store erases the
 * other.
 *
 * The entry holds the SEALED handle, never the key: the key is in no
 * document, no log, no event and no read model. It is opened only for a
 * caller of this process (`openKey`, the decisions' runner).
 */

export type { JevStatus } from '../../shared/jev'

/** The ways the key check fails, in the person's words. None carries the
 *  key; a refusal carries TypeSafe's own reason when it gave one. */
export const JEV_REFUSED = 'The key was refused by TypeSafe.'
export const JEV_UNREACHABLE = 'The server could not reach TypeSafe.'
export const JEV_NO_KEY = 'No Jev key on this machine.'
const answered = (status: number): string => `TypeSafe answered ${status}.`

const FETCH_TIMEOUT_MS = 10_000
/** The entry's key in `integrations.json`. */
const ENTRY = 'jev'

interface StoredJev {
  sealed: string
  setAt: number
  checkedAt: number | null
  lastError: string | null
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** The stored entry read back as far as it is well formed: without a sealed
 *  handle there is no key, so no entry; any other bad field costs the field. */
function readEntry(raw: unknown): StoredJev | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.sealed !== 'string' || r.sealed === '') return undefined
  return {
    sealed: r.sealed,
    setAt: numberOrNull(r.setAt) ?? 0,
    checkedAt: numberOrNull(r.checkedAt),
    lastError: typeof r.lastError === 'string' ? r.lastError : null
  }
}

function statusOf(entry: StoredJev | undefined): JevStatus {
  if (!entry) return { configured: false, setAt: null, checkedAt: null, lastError: null }
  return {
    configured: true,
    setAt: entry.setAt,
    checkedAt: entry.checkedAt,
    lastError: entry.lastError
  }
}

/** What TypeSafe says in an error's body: its `detail`, a sentence, an
 *  object (its `message` when it names one) or, for a validation error, a
 *  list of `{ msg }`. Null when the body says nothing readable. Pure. */
export function jevDetailText(body: string): string | null {
  let detail: unknown = null
  try {
    detail = (JSON.parse(body) as { detail?: unknown } | null)?.detail ?? null
  } catch {
    return null
  }
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const said = detail
      .map((item) =>
        item && typeof item === 'object' && typeof (item as { msg?: unknown }).msg === 'string'
          ? (item as { msg: string }).msg
          : null
      )
      .filter((msg): msg is string => !!msg)
    return said.length ? said.join('; ') : null
  }
  if (detail && typeof detail === 'object') {
    const message = (detail as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return null
}

/** The sentence for a refused key: TypeSafe's own reason, cleaned of the
 *  key (`cleanReason`), after `JEV_REFUSED_PREFIX`; the plain refusal when
 *  nothing readable is left. Pure. */
export function jevRefusedSentence(body: string, key: string | null): string {
  const said = jevDetailText(body)
  const reason = said ? cleanReason(said, key) : ''
  if (!/\p{L}/u.test(reason)) return JEV_REFUSED
  return `${JEV_REFUSED_PREFIX}${/[.!?…]$/.test(reason) ? reason : `${reason}.`}`
}

export const JEV_API = 'https://api.typesafe.ai'

/** The base URL the environment names in place of TypeSafe
 *  (`CLAVE_JEV_BASE_URL`, read at each call: a test's stub), honoured only
 *  under the end-to-end harness (`--test-no-activate`), exactly as
 *  `elevenLabsBaseUrlOverride`. In any other run it is ignored, with no
 *  escape hatch: whoever can set a server's environment must not be able to
 *  send the key elsewhere. Null when there is none to honour. */
export function jevBaseUrlOverride(
  env: NodeJS.ProcessEnv = process.env,
  testMode: boolean = TEST_NO_ACTIVATE
): string | null {
  const named = env.CLAVE_JEV_BASE_URL?.trim()
  if (!named) return null
  return testMode ? named : null
}

/** Where TypeSafe is: the harness's override (above), else the public API.
 *  The decisions ask the place the store checks the key against. */
export const jevBaseUrl = (): string => jevBaseUrlOverride() ?? JEV_API

export interface JevIntegrationOptions {
  /** Where TypeSafe is; `jevBaseUrl` by default. */
  baseUrl?: () => string
  now?: () => number
}

/** A refusal with the sentence for the person: a plain `Error`, which the
 *  settings handlers answer as `SettingsRefused`. */
const refusal = (message: string): Error => new Error(message)

export class JevIntegration {
  private readonly listeners = new Set<(status: JevStatus) => void>()
  private readonly baseUrl: () => string
  private readonly now: () => number

  constructor(
    private readonly ports: SettingsPorts = lazySettingsPorts,
    options: JevIntegrationOptions = {}
  ) {
    this.baseUrl = options.baseUrl ?? jevBaseUrl
    this.now = options.now ?? Date.now
  }

  private load(): StoredJev | undefined {
    return readEntry(readIntegrationEntry(this.ports, ENTRY))
  }

  /** Writes this store's entry alone (none deletes it): the ElevenLabs key
   *  beside it stays as it is. Every listener hears the status after. */
  private save(entry: StoredJev | undefined): JevStatus {
    writeIntegrationEntry(this.ports, ENTRY, entry)
    const status = statusOf(entry)
    for (const listener of [...this.listeners]) {
      try {
        listener(status)
      } catch (error) {
        console.error('[integrations] jev listener failed', error)
      }
    }
    return status
  }

  /** Every change, after the write, with the status (never the key). */
  onChange(listener: (status: JevStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  status(): JevStatus {
    return statusOf(this.load())
  }

  /** Seal and store a pasted key, then check it (`check`). A failed check
   *  keeps the key (a network failure must not lose a paste) and says so in
   *  `lastError`. */
  async setKey(apiKey: string): Promise<JevStatus> {
    const trimmed = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (!trimmed) throw refusal('Paste the API key first.')
    if (!(await this.ports.secrets.available()))
      throw refusal('This machine cannot store a secret.')
    // Sealed first, the old one forgotten after: a seal that fails leaves the
    // working key in place.
    const sealed = await this.ports.secrets.seal(trimmed)
    await serialIntegrations(async () => {
      const previous = this.load()
      try {
        this.save({ sealed, setAt: this.now(), checkedAt: null, lastError: null })
      } catch (error) {
        await this.ports.secrets.discard(sealed)
        throw error
      }
      if (previous && previous.sealed !== sealed) await this.ports.secrets.discard(previous.sealed)
    })
    return this.check()
  }

  /** Check the key against the list of models (`GET /v1/models`), which
   *  sends nothing of ours. A refusal says why in TypeSafe's own words,
   *  never with the key.
   *
   *  The outcome is stored only while the key checked is still the one
   *  stored: a Remove or a Replace while TypeSafe is asked wins, and the
   *  check then writes nothing. */
  async check(): Promise<JevStatus> {
    const opened = this.load()
    if (!opened) return statusOf(undefined)
    const { sealed } = opened
    const key = await this.open(sealed)
    const checkedAt = this.now()
    const lastError = key
      ? await this.askModels(key)
      : 'The key stored on this machine could not be opened.'
    return serialIntegrations(() => {
      // Read again after the call: only the check's own fields, only onto
      // the entry whose key it checked.
      const entry = this.load()
      if (!entry || entry.sealed !== sealed) return statusOf(entry)
      return this.save({ ...entry, lastError, checkedAt })
    })
  }

  /** Forget the key: its sealed handle discarded, the entry gone. */
  async removeKey(): Promise<JevStatus> {
    return serialIntegrations(async () => {
      const entry = this.load()
      if (!entry) return statusOf(undefined)
      const status = this.save(undefined)
      await this.ports.secrets.discard(entry.sealed)
      return status
    })
  }

  /** The key, for a caller of this process only (the decisions' runner).
   *  Null when there is none or the port cannot open it here. */
  async openKey(): Promise<string | null> {
    const entry = this.load()
    return entry ? this.open(entry.sealed) : null
  }

  private async open(sealed: string): Promise<string | null> {
    try {
      return (await this.ports.secrets.open(sealed)) ?? null
    } catch {
      return null
    }
  }

  /** The one call of the check, under its deadline: null when the key is
   *  good, the sentence of the failure otherwise. */
  private async askModels(key: string): Promise<string | null> {
    const base = this.baseUrl().replace(/\/+$/, '')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(`${base}/v1/models`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: controller.signal
      })
      if (res.ok) {
        // Read whole, so the connection is released; what it lists is not ours.
        await res.text().catch(() => '')
        return null
      }
      const text = (await res.text().catch(() => '')).slice(0, 4096)
      if (res.status === 401 || res.status === 403) return jevRefusedSentence(text, key)
      return answered(res.status)
    } catch {
      return JEV_UNREACHABLE
    } finally {
      clearTimeout(timer)
    }
  }
}

/** This process's integration, on its own settings ports. */
export const jevIntegration = new JevIntegration()
