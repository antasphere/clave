/**
 * The speech port (PRDCT-4411): what the server needs from whoever turns
 * text into the voice of its machine. The app's implementation
 * (`src/main/speech.ts`, `hostSpeech`) speaks with the ElevenLabs key sealed
 * on the machine and the voice chosen there; a server with nothing behind it
 * runs on `SpeechPort.none`, which refuses every call as unavailable.
 */
import { Context, Layer } from 'effect'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type { SpeakRequest, SpeakResult } from '@clave/contract/speech'

export interface SpeechService {
  /** The text in the machine's voice (or the voice and model asked). */
  readonly speak: (request: SpeakRequest) => Promise<SpeakResult>
  /** A voice's own preview sample. */
  readonly preview: (voiceId: string) => Promise<SpeakResult>
}

const NO_SPEECH = new CapabilityUnavailable({
  capability: 'speech',
  message: 'This server speaks no text.'
})
const refuse = (): Promise<never> => Promise.reject(NO_SPEECH)

export class SpeechPort extends Context.Tag('@clave/server/Speech')<SpeechPort, SpeechService>() {
  static layer(service: SpeechService): Layer.Layer<SpeechPort> {
    return Layer.succeed(SpeechPort, service)
  }
  /** A server with no voice behind it: every call says so. */
  static readonly none: SpeechService = { speak: refuse, preview: refuse }
}
