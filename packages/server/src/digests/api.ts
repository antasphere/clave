import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import { HttpCqrs } from '@structure-ai/http'
import { ClaveApi } from '@clave/contract/api'
import {
  GetExchangeDigests,
  GetPageTitles,
  GetSpokenRenderings,
  GetWorkDigests,
  ReadExchangeDigest,
  ReadPageTitle,
  ReadSpokenRendering,
  ReadWorkDigest
} from '@clave/contract/digests'

/** PRDCT-4327: the digests, under the bearer token like every route. */
export const DigestsLive = HttpApiBuilder.group(ClaveApi, 'digests', (handlers) =>
  handlers
    .handle('exchange', HttpCqrs.command(ReadExchangeDigest))
    .handle('exchangesOf', HttpCqrs.query(GetExchangeDigests))
    .handle('work', HttpCqrs.command(ReadWorkDigest))
    .handle('workOf', HttpCqrs.query(GetWorkDigests))
    .handle('spoken', HttpCqrs.command(ReadSpokenRendering))
    .handle('spokenOf', HttpCqrs.query(GetSpokenRenderings))
    .handle('title', HttpCqrs.command(ReadPageTitle))
    .handle('titleOf', HttpCqrs.query(GetPageTitles))
)
