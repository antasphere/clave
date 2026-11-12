/**
 * Settings domain: the integrations (PRDCT-4410). A machine (this Mac's
 * server, or a saved Clave server) holds ONE ElevenLabs API key, sealed by
 * its own secret port and checked against the account, with the voice and
 * the model the agents' speech uses. The key enters through one command
 * (`SetElevenLabsKey`, redacted) and comes back in nothing: every answer is
 * the status, which says whether a key is held, never what it is.
 *
 * Mirrors `src/main/integrations/elevenlabs.ts`, the store on the host.
 */
import { Command, Query } from '@structure-ai/cqrs'
import { Schema } from 'effect'
import { RefusedOrUnavailable } from './failures'

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const ElevenLabsModelId = Schema.Literal('eleven_flash_v2_5', 'eleven_multilingual_v2')

export const ElevenLabsStatusView = Schema.Struct({
  /** A sealed key is stored on the machine. */
  configured: Schema.Boolean,
  setAt: Schema.NullOr(Schema.Number),
  voiceId: Schema.NullOr(Schema.String),
  voiceName: Schema.NullOr(Schema.String),
  modelId: ElevenLabsModelId,
  checkedAt: Schema.NullOr(Schema.Number),
  tier: Schema.NullOr(Schema.String),
  charactersUsed: Schema.NullOr(Schema.Number),
  charactersLimit: Schema.NullOr(Schema.Number),
  /** The last check's failure in the person's words; null when it passed. */
  lastError: Schema.NullOr(Schema.String)
})

export const IntegrationsView = Schema.Struct({ elevenLabs: ElevenLabsStatusView })

export const ElevenLabsVoiceView = Schema.Struct({
  voiceId: Schema.String,
  name: Schema.String,
  category: Schema.String,
  labels: Schema.Record({ key: Schema.String, value: Schema.String }),
  previewUrl: Schema.NullOr(Schema.String)
})

export const ElevenLabsVoicesView = Schema.Struct({ voices: Schema.Array(ElevenLabsVoiceView) })

// ---------------------------------------------------------------------------
// Commands and queries — every write answers the whole status.
// ---------------------------------------------------------------------------

/** `integrations:read` */
export const ReadIntegrations = Query.define('ReadIntegrations', {
  payload: Schema.Struct({}),
  success: IntegrationsView,
  failure: RefusedOrUnavailable
})

/** `integrations:elevenlabs-set-key` — sealed on the machine, then checked;
 *  a failed check keeps the key and says why in `lastError`. */
export const SetElevenLabsKey = Command.define('SetElevenLabsKey', {
  payload: Schema.Struct({ apiKey: Schema.Redacted(Schema.String) }),
  success: IntegrationsView,
  failure: RefusedOrUnavailable
})

/** `integrations:elevenlabs-check` — read the account again. */
export const CheckElevenLabs = Command.define('CheckElevenLabs', {
  payload: Schema.Struct({}),
  success: IntegrationsView,
  failure: RefusedOrUnavailable
})

/** `integrations:elevenlabs-remove` — the sealed key forgotten. */
export const RemoveElevenLabsKey = Command.define('RemoveElevenLabsKey', {
  payload: Schema.Struct({}),
  success: IntegrationsView,
  failure: RefusedOrUnavailable
})

/** `integrations:elevenlabs-set-voice` — the voice, and the model when given. */
export const SetElevenLabsVoice = Command.define('SetElevenLabsVoice', {
  payload: Schema.Struct({
    voiceId: Schema.String,
    voiceName: Schema.String,
    modelId: Schema.optional(ElevenLabsModelId)
  }),
  success: IntegrationsView,
  failure: RefusedOrUnavailable
})

/** `integrations:elevenlabs-voices` — the account's voices, read live. */
export const ListElevenLabsVoices = Query.define('ListElevenLabsVoices', {
  payload: Schema.Struct({}),
  success: ElevenLabsVoicesView,
  failure: RefusedOrUnavailable
})
