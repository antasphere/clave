import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import { HttpCqrs } from '@structure-ai/http'
import { ClaveApi } from '@clave/contract/api'
import { ReadTabProjects } from '@clave/contract/decisions'

/** PRDCT-5179: the decisions, under the bearer token like every route. */
export const DecisionsLive = HttpApiBuilder.group(ClaveApi, 'decisions', (handlers) =>
  handlers.handle('readTabProjects', HttpCqrs.command(ReadTabProjects))
)
