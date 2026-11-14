/**
 * The models catalogue as a window reads it (PRDCT-4496): the providers
 * models.dev lists and their models, pruned to what the launcher shows, with
 * when the host last fetched it and whether that read is stale. The host
 * (this Mac's main, or a Clave server) keeps the catalogue; this is the shape
 * it answers on both roads, IPC and the server's `ReadModelsCatalog`.
 *
 * ZERO imports, on its own subpath (`@clave/contract/settings/models-catalog-view`):
 * the window loads this module at value level, and a module that reaches
 * `@structure-ai/cqrs` or Effect breaks the renderer's build. The Effect
 * schemas are built from these constants in `models-catalog.ts`.
 */

/** A model's release stage, as models.dev says it; absent, a stable model. */
export const CATALOG_MODEL_STATUSES = ['deprecated', 'beta', 'alpha'] as const
export type CatalogModelStatus = (typeof CATALOG_MODEL_STATUSES)[number]

export interface CatalogModelView {
  id: string
  name: string
  reasoning: boolean
  toolCall: boolean
  status?: CatalogModelStatus
  contextLimit?: number
  outputLimit?: number
}

export interface CatalogProviderView {
  id: string
  name: string
  models: CatalogModelView[]
}

export interface ModelsCatalogView {
  /** When the host fetched the catalogue it answers from; null, never fetched. */
  fetchedAt: number | null
  /** The last fetch failed: the answer is the newest copy the host still had. */
  stale: boolean
  /** The failed fetch in the person's words, never the service's own text. */
  error?: string
  providers: CatalogProviderView[]
}

/** A provider's models a launcher lists: the deprecated ones hidden; [] when
 *  the provider is not in the catalogue. */
export function catalogModelsOf(view: ModelsCatalogView, providerId: string): CatalogModelView[] {
  const provider = view.providers.find((p) => p.id === providerId)
  return provider ? provider.models.filter((m) => m.status !== 'deprecated') : []
}
