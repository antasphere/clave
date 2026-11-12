/**
 * The speech domain of the client (PRDCT-4411): a Folio page's text spoken
 * with the ElevenLabs voice of the server the tab runs on, and a voice's
 * preview sample for the Integrations page. A speak waits on the service
 * (the server gives it a minute), so it runs on the patient deadline.
 *
 * A server that answered without the speech (a release before it: its
 * router's 404; or one with nothing behind the port: `CapabilityUnavailable`)
 * reads as `outdated`, never as a server that did not answer; a request it
 * refused as invalid (a 400) reads as `failed`, since asking again sends the
 * same thing.
 */
import type { PreviewRequest, SpeakRequest, SpeakResult } from '@clave/contract/speech'
import { Schema } from 'effect'
import { BadRequestProblem, NotFoundProblem } from '@structure-ai/http'
import type { Call } from './call'

export interface SpeechClient {
  readonly speak: (request: SpeakRequest) => Promise<SpeakResult>
  readonly preview: (request: PreviewRequest) => Promise<SpeakResult>
}

/** The server answered, without the speech. */
export const isSpeechMissing = (error: unknown): boolean =>
  (error instanceof Error && Schema.is(NotFoundProblem)(error.cause)) ||
  (typeof error === 'object' &&
    error !== null &&
    (error as { _tag?: unknown })._tag === 'CapabilityUnavailable' &&
    (error as { capability?: unknown }).capability === 'speech')

/** The server refused what it was sent as invalid. */
export const isSpeechRefused = (error: unknown): boolean =>
  error instanceof Error && Schema.is(BadRequestProblem)(error.cause)

export const SPEECH_OUTDATED: SpeakResult = {
  ok: false,
  error: 'This server has no speech: it needs an update',
  reason: 'outdated'
}

export const SPEECH_REFUSED: SpeakResult = {
  ok: false,
  error: 'The server refused the request as invalid',
  reason: 'failed'
}

const orOutdated = (run: Promise<SpeakResult>): Promise<SpeakResult> =>
  run.catch((error: unknown) => {
    if (isSpeechMissing(error)) return SPEECH_OUTDATED
    if (isSpeechRefused(error)) return SPEECH_REFUSED
    throw error
  })

export const speechClient = (call: Call, patientCall: Call = call): SpeechClient => ({
  speak: ({ sessionId, text, voiceId, modelId }) =>
    orOutdated(
      patientCall((c) =>
        c.speech.speak({
          payload: {
            sessionId,
            text,
            ...(voiceId !== undefined && { voiceId }),
            ...(modelId !== undefined && { modelId })
          }
        })
      )
    ),
  preview: ({ voiceId }) =>
    orOutdated(patientCall((c) => c.speech.preview({ payload: { voiceId } })))
})
