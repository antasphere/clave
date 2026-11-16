/**
 * Settings domain: the models catalogue (PRDCT-4496). The host (this Mac's
 * server, or a saved Clave server) reads models.dev, caches it a day, and
 * answers the providers and their models the launcher lists under Pi and
 * OpenCode, so a window attached to a server lists what THAT server's
 * catalogue holds.
 *
 * The view's plain shape and its constants live in `models-catalog-view.ts`,
 * which the window loads; the schemas here are built from them.
 *
 * Mirrors `src/main/models-catalog.ts`, the catalogue on the host.
 */
import { Query } from '@structure-ai/cqrs'
import { Schema } from 'effect'
import { RefusedOrUnavailable } from './failures'
import { CATALOG_MODEL_STATUSES } from './models-catalog-view'

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const CatalogModelStatus = Schema.Literal(...CATALOG_MODEL_STATUSES)

export const CatalogModelView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  reasoning: Schema.Boolean,
  toolCall: Schema.Boolean,
  status: Schema.optional(CatalogModelStatus),
  contextLimit: Schema.optional(Schema.Number),
  outputLimit: Schema.optional(Schema.Number)
})

export const CatalogProviderView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  models: Schema.Array(CatalogModelView)
})

export const ModelsCatalogView = Schema.Struct({
  /** When the host fetched it; null, never fetched. */
  fetchedAt: Schema.NullOr(Schema.Number),
  /** The last fetch failed: the answer is the newest copy the host still had. */
  stale: Schema.Boolean,
  /** The failed fetch in the person's words, never the service's own text. */
  error: Schema.optional(Schema.String),
  providers: Schema.Array(CatalogProviderView)
})

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** `models-catalog:read` — the providers of those ids in their order (all of
 *  them when none is named), fetched again first with `force`. A query's
 *  payload is decoded from the URL: the ids travel comma-joined, the flag as
 *  a string. */
export const ReadModelsCatalog = Query.define('ReadModelsCatalog', {
  payload: Schema.Struct({
    providerIds: Schema.optional(Schema.split(',')),
    force: Schema.optional(Schema.BooleanFromString)
  }),
  success: ModelsCatalogView,
  failure: RefusedOrUnavailable
})
