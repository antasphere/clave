/**
 * The models the launcher lists under Pi and OpenCode (PRDCT-4496): the
 * harness's own default first, then, per provider connection in the source's
 * order, the catalogue models of its company (deduplicated by id, the
 * deprecated ones hidden by `catalogModelsOf`), then the models Pi's saved
 * profiles pin. A company with no catalogue id (Ollama, another provider)
 * lists no catalogue model. Pure and shared, so the launcher menu, the
 * window's `clave_launch_options` and the daemon's read the same lists.
 */
import {
  catalogModelsOf,
  type ModelsCatalogView
} from '@clave/contract/settings/models-catalog-view'

/** A model row: `id` undefined is the harness's own default (no flag). */
export interface ProviderModelRow {
  id: string | undefined
  label: string
  /** Whose credits it spends: the company's name, `Default`, or the id. */
  family: string
}

/** A connection as the listing reads it. `company` is a `ProviderCompanyId`
 *  of `src/main/models-catalog-overlay.ts`, kept a string here: nothing in
 *  `src/shared` imports from main. */
export interface ProviderConnectionRef {
  id: string
  company: string
}

/** The two facts of a `ProviderCompany` the listing reads: its name, and its
 *  models.dev provider id (null when the catalogue has none). */
export interface ProviderCompanyFacts {
  name: string
  catalog: string | null
}

/** Every company by id: `PROVIDER_COMPANY_BY_ID` fits it. */
export type ProviderCompanies = Readonly<Record<string, ProviderCompanyFacts>>

export const DEFAULT_PROVIDER_MODEL: ProviderModelRow = {
  id: undefined,
  label: 'Default',
  family: 'Default'
}

/** `view` is the machine's catalogue, `'loading'` while its read is under
 *  way, null when there is none (never read, or the read failed with no copy
 *  before it). Loading is said only when a connection waits on it. */
export function modelsForProviderConnections(
  view: ModelsCatalogView | 'loading' | null,
  connections: readonly ProviderConnectionRef[],
  companies: ProviderCompanies,
  pinned: readonly string[] = []
): ProviderModelRow[] | 'loading' {
  const withCatalog = connections.filter((c) => companies[c.company]?.catalog)
  if (view === 'loading' && withCatalog.length > 0) return 'loading'
  const rows: ProviderModelRow[] = [DEFAULT_PROVIDER_MODEL]
  const seen = new Set<string>()
  if (view && view !== 'loading') {
    for (const connection of withCatalog) {
      const company = companies[connection.company]
      for (const model of catalogModelsOf(view, company.catalog!)) {
        if (seen.has(model.id)) continue
        seen.add(model.id)
        rows.push({ id: model.id, label: model.name, family: company.name })
      }
    }
  }
  for (const id of pinned) {
    if (seen.has(id)) continue
    seen.add(id)
    rows.push({ id, label: id, family: id })
  }
  return rows
}

/** The connections a model row offers: every one for the default row, else
 *  those whose company's catalogue lists the model. */
export function connectionsServingModel<C extends ProviderConnectionRef>(
  view: ModelsCatalogView | 'loading' | null,
  connections: readonly C[],
  companies: ProviderCompanies,
  model: string | undefined
): C[] {
  if (model === undefined) return [...connections]
  if (!view || view === 'loading') return []
  return connections.filter((connection) => {
    const catalog = companies[connection.company]?.catalog
    return !!catalog && catalogModelsOf(view, catalog).some((m) => m.id === model)
  })
}
