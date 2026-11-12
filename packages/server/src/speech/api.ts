import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import { HttpCqrs } from '@structure-ai/http'
import { ClaveApi } from '@clave/contract/api'
import { PreviewVoice, SpeakText } from '@clave/contract/speech'

/** PRDCT-4411: the speech, under the bearer token like every route. */
export const SpeechLive = HttpApiBuilder.group(ClaveApi, 'speech', (handlers) =>
  handlers
    .handle('speak', HttpCqrs.command(SpeakText))
    .handle('preview', HttpCqrs.command(PreviewVoice))
)
