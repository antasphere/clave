/**
 * The ElevenLabs integration as every side reads it (PRDCT-4410): the host's
 * store (`src/main/integrations/elevenlabs.ts`), the preload's members and
 * the Settings page. The wire's schemas are
 * `@clave/contract/settings/integrations`, written from these. Pure: no
 * process, no network, so the renderer imports it.
 *
 * The key itself appears in none of these shapes: a machine says whether it
 * holds one, never what it is.
 */

/** The two models the agents' speech may run on. */
export type ElevenLabsModelId = 'eleven_flash_v2_5' | 'eleven_multilingual_v2'

export const DEFAULT_ELEVENLABS_MODEL: ElevenLabsModelId = 'eleven_flash_v2_5'

export const ELEVENLABS_MODELS: ReadonlyArray<{
  id: ElevenLabsModelId
  label: string
  note: string
}> = [
  {
    id: 'eleven_flash_v2_5',
    label: 'Flash v2.5',
    note: 'fast, half a credit a character, 40,000 characters a request'
  },
  {
    id: 'eleven_multilingual_v2',
    label: 'Multilingual v2',
    note: 'richer, one credit a character, 10,000 characters a request'
  }
]

export const isElevenLabsModelId = (value: unknown): value is ElevenLabsModelId =>
  ELEVENLABS_MODELS.some((model) => model.id === value)

/** What a machine says of its ElevenLabs key: whether it holds one, when it
 *  was set, the account it was last checked against, and the voice chosen. */
export interface ElevenLabsStatus {
  configured: boolean
  setAt: number | null
  voiceId: string | null
  voiceName: string | null
  modelId: ElevenLabsModelId
  checkedAt: number | null
  tier: string | null
  charactersUsed: number | null
  charactersLimit: number | null
  /** The last check's failure, in words for the person; null when it passed. */
  lastError: string | null
}

export interface ElevenLabsVoice {
  voiceId: string
  name: string
  category: string
  labels: Record<string, string>
  previewUrl: string | null
}

/** What a key made on elevenlabs.io must allow, said on the Integrations
 *  card before one is pasted (PRDCT-4831): the check asks the voices and the
 *  speech, and reads the account only when the key may. The names are the
 *  website's own. */
export const ELEVENLABS_KEY_PERMISSIONS =
  'On elevenlabs.io, the key needs Text to Speech and Voices: Read. User: Read is optional: with it, this card shows the plan and the credits.'

/** How a refusal that carries ElevenLabs' own reason starts (PRDCT-4831):
 *  the host writes it (`refusedSentence`), the Settings page knows a
 *  sentence that starts so is meant for the person. */
export const ELEVENLABS_REFUSED_PREFIX = 'ElevenLabs refused the key: '

/** Every integration a machine holds; one today. */
export interface IntegrationsStatus {
  elevenLabs: ElevenLabsStatus
}

/** What a server released before the integrations is said to need. The
 *  client says the same words (`packages/client/src/settings.ts`, which
 *  cannot import this file; its test holds the two equal). */
export const INTEGRATIONS_NEED_UPDATE = 'This server needs an update to show its integrations.'
