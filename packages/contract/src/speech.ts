/**
 * The speech domain (PRDCT-4411): a Folio page spoken with the ElevenLabs
 * voice of the server the tab runs on. The server holds the machine's sealed
 * key and the voice chosen on its Integrations page (PRDCT-4410); the client
 * sends text and gets audio back, and never sees the key.
 *
 * - `SpeakText`: the spoken rendering of a page (or one part of it) turned
 *   into audio with the server's voice. The payload names the session, so a
 *   server speaks only for a tab it has a record of.
 * - `PreviewVoice`: a voice's own preview sample, fetched by the server, for
 *   the Integrations page's Preview button.
 *
 * Speech that could not be made is an answer, not a failure of the call:
 * `ok: false` with the class of the reason, which the read control says.
 */
import { Option, Schema } from 'effect'
import { Command } from '@structure-ai/cqrs'
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import { CapabilityUnavailable } from './errors'
import { ElevenLabsModelId } from './settings/integrations'

export const SPEECH_FAILURE_REASONS = [
  // No key on the server, or no voice chosen there.
  'no-integration',
  'no-voice',
  // The service refused the key, or the account's credits are spent.
  'refused',
  'quota',
  // The service could not be reached.
  'unreachable',
  // The server has no record of the tab.
  'unknown-session',
  // The client's own: a server released before the speech domain.
  'outdated',
  'failed'
] as const
export type SpeechFailureReason = (typeof SPEECH_FAILURE_REASONS)[number]
const isReason = (value: unknown): value is SpeechFailureReason =>
  (SPEECH_FAILURE_REASONS as readonly unknown[]).includes(value)

/** A reason this Mac does not know (a newer server's) reads as absent, so
 *  the rest of the answer still decodes; the client reads absent as failed. */
const reason = Schema.optionalToOptional(Schema.String, Schema.Literal(...SPEECH_FAILURE_REASONS), {
  decode: (value) => Option.filter(value, isReason),
  encode: (value) => value
})

/** The longest text one call may speak. A page is cut into parts well under
 *  it (`speechParts` in the chat view, 2,400 characters). */
export const SPEECH_MAX_TEXT = 5_000
/** A voice id as the service names it: letters, digits, `_` and `-`. */
export const VoiceId = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,64}$/))
const SessionId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256))

export const SpeakDone = Schema.Struct({
  ok: Schema.Literal(true),
  mime: Schema.Literal('audio/mpeg'),
  /** The audio, base64. */
  audio: Schema.String,
  /** The characters spoken (what the account is charged). */
  characters: Schema.Number
})

const NotSpoken = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.String,
  reason
})

export const SpeakResult = Schema.Union(SpeakDone, NotSpoken)
export type SpeakResult = typeof SpeakResult.Type

export const SpeakText = Command.define('SpeakText', {
  payload: Schema.Struct({
    sessionId: SessionId,
    text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(SPEECH_MAX_TEXT)),
    voiceId: Schema.optional(VoiceId),
    modelId: Schema.optional(ElevenLabsModelId)
  }),
  success: SpeakResult,
  failure: CapabilityUnavailable
})

export const PreviewVoice = Command.define('PreviewVoice', {
  payload: Schema.Struct({ voiceId: VoiceId }),
  success: SpeakResult,
  failure: CapabilityUnavailable
})

export type SpeakRequest = typeof SpeakText.payload.Type
export type PreviewRequest = typeof PreviewVoice.payload.Type

export const speechGroup = ApiGroup.make('speech')
  .add(HttpCqrs.commandEndpoint('speak', '/speech/speak', SpeakText))
  .add(HttpCqrs.commandEndpoint('preview', '/speech/preview', PreviewVoice))
