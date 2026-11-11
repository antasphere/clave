import { UNKNOWN_SESSION_ERROR, type DigestRecordOf } from './exchange-digest'
import {
  ELEVENLABS_REFUSED,
  ELEVENLABS_UNREACHABLE,
  elevenLabsBaseUrl,
  elevenLabsBaseUrlOverride,
  elevenLabsIntegration
} from './integrations/elevenlabs'
import { isElevenLabsModelId, type ElevenLabsModelId } from '../shared/elevenlabs'
import { SPEECH_MAX_TEXT, type SpeakResult, type SpeechFailureReason } from '../shared/speech'

/**
 * Folio's speech on the host (PRDCT-4411): the spoken rendering of a page,
 * one part at a time, turned into audio with THIS process's ElevenLabs key
 * (sealed by its secret port, `integrations/elevenlabs.ts`) and the voice
 * chosen on its Integrations page. Served to the clients of the server the
 * tab runs on (`SpeechPort` of `@clave/server`), in-process and standalone
 * alike, and over IPC to a window whose server is main.
 *
 * The key is opened for one request and lives only in that call's frame; it
 * goes in one header, to the ElevenLabs base URL only, and never into an
 * answer, an error or a log. A voice's preview sample is fetched WITHOUT it.
 */

const SPEAK_TIMEOUT_MS = 60_000
/** The subscription count is read again after a speak at most this often. */
const REFRESH_EVERY_MS = 60_000
/** The largest preview sample read (a preview is a few seconds of mp3). */
const PREVIEW_MAX_BYTES = 8 * 1024 * 1024

export const SPEECH_NO_KEY = 'No ElevenLabs key on this server.'
export const SPEECH_NO_VOICE = 'No ElevenLabs voice chosen on this server.'
export const SPEECH_QUOTA = 'The ElevenLabs credits are spent.'
export const SPEECH_NO_PREVIEW = 'This voice has no preview.'
const answered = (status: number): string => `ElevenLabs answered ${status}.`

/** What the speech route needs of the machine's integration. */
export interface SpeechIntegration {
  openKey: () => Promise<string | null>
  status: () => { voiceId: string | null; modelId: ElevenLabsModelId }
  check: () => Promise<unknown>
}

export interface HostSpeechOptions {
  integration?: SpeechIntegration
  baseUrl?: () => string
  /** The stub the end-to-end harness put in place of the service, whose own
   *  preview files are fetched too (`elevenLabsBaseUrlOverride`: null in any
   *  other run). */
  harnessBaseUrl?: () => string | null
  now?: () => number
}

export interface HostSpeech {
  speak: (request: {
    sessionId: string
    text: string
    voiceId?: string
    modelId?: ElevenLabsModelId
  }) => Promise<SpeakResult>
  preview: (voiceId: string) => Promise<SpeakResult>
}

const not = (reason: SpeechFailureReason, error: string): SpeakResult => ({
  ok: false,
  error,
  reason
})

/** A voice id as the service names it; anything else never reaches a URL. */
const VOICE_ID = /^[A-Za-z0-9_-]{1,64}$/

/** The hosts a voice's preview sample is fetched from: the service's own,
 *  and the public bucket its previews are kept in. */
const PREVIEW_HOSTS = new Set(['api.elevenlabs.io', 'elevenlabs.io', 'storage.googleapis.com'])

/** Whether a preview URL the voice answer names is one of the service's own
 *  files: https, on its default port, without credentials, on an ElevenLabs
 *  host (or a subdomain of elevenlabs.io) or the public preview bucket. Any
 *  other (plain http, a loopback or private address, another host) is never
 *  fetched. Pure. */
export function allowedPreviewUrl(url: string): boolean {
  let where: URL
  try {
    where = new URL(url)
  } catch {
    return false
  }
  if (where.protocol !== 'https:' || where.port !== '') return false
  if (where.username || where.password) return false
  const host = where.hostname.toLowerCase()
  return PREVIEW_HOSTS.has(host) || host.endsWith('.elevenlabs.io')
}

/** Whether a refusal's body says the account's credits are spent. */
function quotaExceeded(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { detail?: { status?: unknown } } | null
    if (parsed?.detail?.status === 'quota_exceeded') return true
  } catch {
    /* not JSON: read as text below */
  }
  return body.includes('quota_exceeded')
}

/** A refusal of the service, in the person's words: never its own text,
 *  never the key. */
export function speechRefusal(status: number, body: string): SpeakResult {
  if (status === 402) return not('quota', SPEECH_QUOTA)
  // The service answers a spent account 401, 400 or 429 with
  // `quota_exceeded` in its detail: that is the credits, not the key.
  if ((status === 400 || status === 401 || status === 429) && quotaExceeded(body))
    return not('quota', SPEECH_QUOTA)
  if (status === 401 || status === 403) return not('refused', ELEVENLABS_REFUSED)
  return not('failed', answered(status))
}

/** A call's answer, read whole under the deadline. */
interface Answer {
  ok: boolean
  status: number
  headers: Headers
  bytes: Buffer
}

async function timed(url: string, init: RequestInit): Promise<Answer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SPEAK_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    // The body is read under the same deadline.
    const bytes = Buffer.from(await res.arrayBuffer())
    return { ok: res.ok, status: res.status, headers: res.headers, bytes }
  } finally {
    clearTimeout(timer)
  }
}

const textOf = (answer: Answer): string => answer.bytes.subarray(0, 4096).toString('utf8')

/** The speech a host serves: every speak for a session it has a record of,
 *  with its machine's key and voice. */
export function hostSpeech(recordOf: DigestRecordOf, options: HostSpeechOptions = {}): HostSpeech {
  const integration = options.integration ?? elevenLabsIntegration
  const base = (): string => (options.baseUrl ?? elevenLabsBaseUrl)().replace(/\/+$/, '')
  const now = options.now ?? Date.now
  const harnessBase = options.harnessBaseUrl ?? elevenLabsBaseUrlOverride
  /** A preview URL on the harness's stub, under the harness only. */
  const onHarness = (where: URL): boolean => {
    const stub = harnessBase()
    if (!stub) return false
    try {
      return new URL(stub).origin === where.origin
    } catch {
      return false
    }
  }
  let refreshedAt = Number.NEGATIVE_INFINITY
  /** The Integrations card shows the credits spent: the account is read
   *  again after a speak, once a minute at most. */
  const refresh = (): void => {
    const at = now()
    if (at - refreshedAt < REFRESH_EVERY_MS) return
    refreshedAt = at
    void integration.check().catch(() => undefined)
  }

  return {
    speak: async (request) => {
      if (!recordOf(request.sessionId)) return not('unknown-session', UNKNOWN_SESSION_ERROR)
      const text = typeof request.text === 'string' ? request.text : ''
      if (!text.trim()) return not('failed', 'Nothing to speak.')
      if (text.length > SPEECH_MAX_TEXT) return not('failed', 'Too much text for one call.')
      const key = await integration.openKey().catch(() => null)
      if (!key) return not('no-integration', SPEECH_NO_KEY)
      const status = integration.status()
      const voiceId = request.voiceId ?? status.voiceId
      if (!voiceId) return not('no-voice', SPEECH_NO_VOICE)
      if (!VOICE_ID.test(voiceId)) return not('failed', 'That is not a voice.')
      const modelId =
        request.modelId !== undefined && isElevenLabsModelId(request.modelId)
          ? request.modelId
          : status.modelId
      let res: Answer
      try {
        res = await timed(
          `${base()}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
          {
            method: 'POST',
            headers: {
              'xi-api-key': key,
              'content-type': 'application/json',
              accept: 'audio/mpeg'
            },
            body: JSON.stringify({ text, model_id: modelId })
          }
        )
      } catch {
        return not('unreachable', ELEVENLABS_UNREACHABLE)
      }
      if (!res.ok) return speechRefusal(res.status, textOf(res))
      const { bytes } = res
      if (bytes.length === 0) return not('failed', 'ElevenLabs answered no audio.')
      refresh()
      const header = res.headers.get('x-character-count')
      const charged = header ? Number(header) : Number.NaN
      return {
        ok: true,
        mime: 'audio/mpeg',
        audio: bytes.toString('base64'),
        characters: Number.isFinite(charged) && charged >= 0 ? charged : text.length
      }
    },

    preview: async (voiceId) => {
      if (typeof voiceId !== 'string' || !VOICE_ID.test(voiceId))
        return not('failed', 'That is not a voice.')
      const key = await integration.openKey().catch(() => null)
      if (!key) return not('no-integration', SPEECH_NO_KEY)
      let voice: Answer
      try {
        voice = await timed(`${base()}/v1/voices/${encodeURIComponent(voiceId)}`, {
          headers: { 'xi-api-key': key, accept: 'application/json' }
        })
      } catch {
        return not('unreachable', ELEVENLABS_UNREACHABLE)
      }
      if (!voice.ok) return speechRefusal(voice.status, textOf(voice))
      let body: { preview_url?: unknown } | null = null
      try {
        body = JSON.parse(voice.bytes.toString('utf8')) as { preview_url?: unknown } | null
      } catch {
        body = null
      }
      const url = typeof body?.preview_url === 'string' ? body.preview_url : ''
      let where: URL
      try {
        where = new URL(url)
      } catch {
        return not('failed', SPEECH_NO_PREVIEW)
      }
      if (!allowedPreviewUrl(where.toString()) && !onHarness(where))
        return not('failed', SPEECH_NO_PREVIEW)
      let sample: Answer
      try {
        // The sample is the service's public file: the key is not sent, and
        // a redirect (to anywhere else) is a failure, never followed.
        sample = await timed(where.toString(), {
          headers: { accept: 'audio/mpeg' },
          redirect: 'error'
        })
      } catch {
        return not('unreachable', ELEVENLABS_UNREACHABLE)
      }
      if (!sample.ok) return not('failed', answered(sample.status))
      const { bytes } = sample
      if (bytes.length === 0 || bytes.length > PREVIEW_MAX_BYTES)
        return not('failed', SPEECH_NO_PREVIEW)
      return { ok: true, mime: 'audio/mpeg', audio: bytes.toString('base64'), characters: 0 }
    }
  }
}
