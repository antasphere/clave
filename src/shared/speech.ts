/**
 * Folio's speech as every side of the app reads it (PRDCT-4411): the host
 * (`src/main/speech.ts`), the preload's `speakText` and
 * `fleetElevenLabsPreview`, the chat view's audio queue and the Integrations
 * page's Preview. The wire's schemas are `@clave/contract/speech`, written
 * from these. Pure: no process, no network, so the renderer imports it.
 */

/** Why a text could not be spoken with the server's voice. */
export type SpeechFailureReason =
  | 'no-integration'
  | 'no-voice'
  | 'refused'
  | 'quota'
  | 'unreachable'
  | 'unknown-session'
  | 'outdated'
  | 'failed'

export type SpeakDone = {
  ok: true
  mime: 'audio/mpeg'
  /** The audio, base64. */
  audio: string
  characters: number
}

export type SpeakResult = SpeakDone | { ok: false; error: string; reason?: SpeechFailureReason }

/** One part of a page to speak, for the tab it is in. */
export interface SpeakRequest {
  sessionId: string
  text: string
}

/** The longest text one call speaks (the contract's `SPEECH_MAX_TEXT`). */
export const SPEECH_MAX_TEXT = 5_000
