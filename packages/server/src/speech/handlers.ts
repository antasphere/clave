/**
 * The speech domain on the server (PRDCT-4411): each command one call on the
 * port. Speech that could not be made comes back as the port's `ok: false`
 * answer; what the port THROWS is the server saying it cannot speak at all,
 * `CapabilityUnavailable`.
 */
import { Effect } from 'effect'
import { CommandHandler } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from '@clave/contract/errors'
import { PreviewVoice, SpeakText } from '@clave/contract/speech'
import { SpeechPort, type SpeechService } from './port'

const unavailable = (error: unknown): CapabilityUnavailable =>
  error instanceof CapabilityUnavailable
    ? error
    : new CapabilityUnavailable({
        capability: 'speech',
        message: error instanceof Error && error.message ? error.message : String(error)
      })

const call = <A>(
  run: (port: SpeechService) => A | Promise<A>
): Effect.Effect<A, CapabilityUnavailable, SpeechPort> =>
  Effect.flatMap(SpeechPort, (port) =>
    Effect.tryPromise({ try: async () => run(port), catch: unavailable })
  )

export const speechHandlers = [
  CommandHandler.make(SpeakText, (p) =>
    call((s) =>
      s.speak({
        sessionId: p.sessionId,
        text: p.text,
        ...(p.voiceId !== undefined && { voiceId: p.voiceId }),
        ...(p.modelId !== undefined && { modelId: p.modelId })
      })
    )
  ),
  CommandHandler.make(PreviewVoice, (p) => call((s) => s.preview(p.voiceId)))
] as const
