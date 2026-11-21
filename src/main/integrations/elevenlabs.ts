import { lazySettingsPorts, type SettingsPorts } from '../ports/registry'
import { readJson, writeJson } from '../ports/storage'
import { TEST_NO_ACTIVATE } from '../test-mode'
import {
  DEFAULT_ELEVENLABS_MODEL,
  ELEVENLABS_REFUSED_PREFIX,
  isElevenLabsModelId,
  type ElevenLabsModelId,
  type ElevenLabsStatus,
  type ElevenLabsVoice
} from '../../shared/elevenlabs'

/**
 * The ElevenLabs integration of a machine (PRDCT-4410): ONE API key, sealed
 * by the machine's own secret port, checked against what Folio uses (the
 * voices and the speech, PRDCT-4831), with the voice and the model the
 * agents' speech uses. Like the
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

/** The ways a call to ElevenLabs fails, in the person's words. None carries
 *  the key; a refusal carries ElevenLabs' own reason when it gave one
 *  (`refusedSentence`), this sentence only when it gave none. */
export const ELEVENLABS_REFUSED = 'The key was refused by ElevenLabs.'
export const ELEVENLABS_UNREACHABLE = 'The server could not reach ElevenLabs.'
export const ELEVENLABS_NO_KEY = 'No ElevenLabs key on this machine.'
const answered = (status: number): string => `ElevenLabs answered ${status}.`

/** Said after ElevenLabs' own sentence when the key lacks a permission. */
export const ELEVENLABS_PERMISSION_HINT =
  'Allow that permission for this key on elevenlabs.io, or paste a key that has it.'

const FETCH_TIMEOUT_MS = 10_000
const VOICES_CAP = 500
const VOICES_PAGE = 100
/** The longest reason of ElevenLabs' own kept and shown. */
const REASON_MAX = 300

/** The voice the key check asks speech of: no voice has this id, so
 *  ElevenLabs answers `voice_not_found` to a key allowed to speak (no audio,
 *  no credits) and `missing_permissions` to one that is not (reproduced on
 *  21 November 2026 with a key restricted on the website, PRDCT-4831). */
export const KEY_CHECK_VOICE = 'clavekeycheck0000000'

/** What ElevenLabs says in an error's body: its `detail`, an object (the
 *  `status`, `type` and `message` it names) or a bare sentence. */
export interface ServiceDetail {
  status: string | null
  type: string | null
  message: string | null
}

/** The `detail` of an ElevenLabs error body; every field null when the body
 *  says nothing readable. Pure. */
export function serviceDetail(body: string): ServiceDetail {
  let detail: unknown = null
  try {
    detail = (JSON.parse(body) as { detail?: unknown } | null)?.detail ?? null
  } catch {
    detail = null
  }
  if (typeof detail === 'string') return { status: null, type: null, message: detail }
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail))
    return { status: null, type: null, message: null }
  const d = detail as Record<string, unknown>
  return {
    status: stringOrNull(d.status),
    type: stringOrNull(d.type),
    message: stringOrNull(d.message)
  }
}

/** ElevenLabs' own sentence made safe to keep and to show: the key cut out
 *  wherever it appears, anything shaped like a key masked, control
 *  characters dropped, one line, at most `REASON_MAX` characters. Empty when
 *  nothing is left. Pure. */
export function cleanReason(message: string, key: string | null): string {
  let text = message
  if (key) text = text.split(key).join('…')
  text = text
    .replace(/\b(?:sk|xi)[_-][A-Za-z0-9_-]{16,}/g, '…')
    .replace(/[A-Za-z0-9]{40,}/g, '…')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1).trimEnd()}…` : text
}

/** Whether an answer turns the KEY away: a 401 or a 403, or an
 *  authentication error under another status (an invalid key is a 400).
 *  Spent credits are not the key's fault. Pure. */
export function keyRefused(status: number, detail: ServiceDetail): boolean {
  if (detail.status === 'quota_exceeded') return false
  return status === 401 || status === 403 || detail.type === 'authentication_error'
}

/** The sentence for a refused key: ElevenLabs' own reason when it gave one,
 *  with where to fix a missing permission; the plain refusal otherwise.
 *  Never the key. Pure. */
export function refusedSentence(detail: ServiceDetail, key: string | null): string {
  const reason = detail.message ? cleanReason(detail.message, key) : ''
  // Nothing left to read once the key is cut out: the plain refusal.
  if (!/\p{L}/u.test(reason)) return ELEVENLABS_REFUSED
  const said = /[.!?…]$/.test(reason) ? reason : `${reason}.`
  const hint = detail.status === 'missing_permissions' ? ` ${ELEVENLABS_PERMISSION_HINT}` : ''
  return `${ELEVENLABS_REFUSED_PREFIX}${said}${hint}`
}

/** The account's plan and credits, as an entry stores them. */
type AccountFigures = Pick<StoredElevenLabs, 'tier' | 'charactersUsed' | 'charactersLimit'>

const NO_FIGURES: AccountFigures = { tier: null, charactersUsed: null, charactersLimit: null }

/** What an answer of the account says of the figures: its own on a success,
 *  none when the key may not read the account (they are not this key's to
 *  show), null when the account merely failed to answer (the last ones
 *  stay). */
function figuresOf(account: Asked): AccountFigures | null {
  if (account.kind === 'refused') return { ...NO_FIGURES }
  if (account.kind !== 'ok') return null
  return {
    tier: stringOrNull(account.body?.tier),
    charactersUsed: numberOrNull(account.body?.character_count),
    charactersLimit: numberOrNull(account.body?.character_limit)
  }
}

/** One call's outcome, as the check reads it. */
type Asked =
  | { kind: 'ok'; body: Record<string, unknown> | null }
  | { kind: 'refused'; sentence: string }
  | { kind: 'failed'; status: number }
  | { kind: 'unreachable' }

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

  /** Seal and store a pasted key, then check it (`check`). A
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

  /** Check the key against what Folio uses (PRDCT-4831): the voices it
   *  lists and the speech it asks for, the speech on a voice no account has
   *  (`KEY_CHECK_VOICE`) so the check costs nothing. The account's plan and
   *  credits are read beside them and shown when the key may read them,
   *  silently absent when it may not: a key restricted on the website to
   *  the voices and the speech is a good key. A refusal says why in
   *  ElevenLabs' own words (`refusedSentence`), never with the key.
   *
   *  The outcome is stored as long as the key checked is still the one
   *  stored. A Remove or a Replace while ElevenLabs is asked wins: the check
   *  then writes nothing (it never writes back the entry it read before its
   *  calls). */
  async check(): Promise<ElevenLabsStatus> {
    const opened = this.load().elevenLabs
    if (!opened) return statusOf(undefined)
    const { sealed } = opened
    const key = await this.open(sealed)
    const checkedAt = this.now()
    let figures: AccountFigures | null = null
    let lastError: string | null = null
    if (!key) {
      lastError = 'The key stored on this machine could not be opened.'
    } else {
      const [voices, speech, account] = await Promise.all([
        this.ask(`/v2/voices?page_size=1`, key),
        this.ask(`/v1/text-to-speech/${KEY_CHECK_VOICE}?output_format=mp3_44100_128`, key, {
          text: 'a',
          model_id: DEFAULT_ELEVENLABS_MODEL
        }),
        this.ask('/v1/user/subscription', key)
      ])
      // The voices must list; the speech must not be refused (any other
      // answer, the expected `voice_not_found` first, is past the key).
      if (voices.kind === 'refused') lastError = voices.sentence
      else if (speech.kind === 'refused') lastError = speech.sentence
      else if (voices.kind === 'unreachable' || speech.kind === 'unreachable')
        lastError = ELEVENLABS_UNREACHABLE
      else if (voices.kind === 'failed') lastError = answered(voices.status)
      // The key is good whatever the account answered.
      else figures = figuresOf(account)
    }
    return this.serial(() => {
      // Read again after the calls: only the check's own fields, only onto
      // the entry whose key it checked.
      const document = this.load()
      const entry = document.elevenLabs
      if (!entry || entry.sealed !== sealed) return statusOf(entry)
      if (figures) Object.assign(entry, figures)
      entry.lastError = lastError
      entry.checkedAt = checkedAt
      return this.save(document)
    })
  }

  /** Read the account's plan and credits again, after a speak (the speech
   *  route, once a minute at most): stored when the key may read them,
   *  cleared when it no longer may, left as they are when the call fails.
   *  The key itself was just proven by the speak, so nothing else is asked
   *  and the check's own fields are not touched. */
  async refreshAccount(): Promise<ElevenLabsStatus> {
    const opened = this.load().elevenLabs
    if (!opened) return statusOf(undefined)
    const { sealed } = opened
    const key = await this.open(sealed)
    if (!key) return statusOf(opened)
    const figures = figuresOf(await this.ask('/v1/user/subscription', key))
    if (!figures) return statusOf(opened)
    return this.serial(() => {
      const document = this.load()
      const entry = document.elevenLabs
      if (!entry || entry.sealed !== sealed) return statusOf(entry)
      // Nothing new to say: no write, no event.
      if (
        entry.tier === figures.tier &&
        entry.charactersUsed === figures.charactersUsed &&
        entry.charactersLimit === figures.charactersLimit
      )
        return statusOf(entry)
      Object.assign(entry, figures)
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
      const asked = await this.ask(`/v2/voices?${query.toString()}`, key)
      if (asked.kind === 'unreachable') throw refusal(ELEVENLABS_UNREACHABLE)
      if (asked.kind === 'refused') throw refusal(asked.sentence)
      if (asked.kind === 'failed') throw refusal(answered(asked.status))
      const body = asked.body
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

  /** One call, read whole under the deadline: its JSON on a success, the
   *  refusal's sentence when it turns the key away, its status otherwise.
   *  A body is POSTed as JSON when given. */
  private async ask(path: string, key: string, body?: unknown): Promise<Asked> {
    const base = this.baseUrl().replace(/\/+$/, '')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(`${base}${path}`, {
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: {
          'xi-api-key': key,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        signal: controller.signal
      })
      if (res.ok) {
        const parsed = (await res.json().catch(() => null)) as unknown
        const record =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null
        return { kind: 'ok', body: record }
      }
      const text = (await res.text().catch(() => '')).slice(0, 4096)
      const detail = serviceDetail(text)
      if (keyRefused(res.status, detail))
        return { kind: 'refused', sentence: refusedSentence(detail, key) }
      return { kind: 'failed', status: res.status }
    } catch {
      return { kind: 'unreachable' }
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
