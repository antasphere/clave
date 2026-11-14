/**
 * The models Settings reads to name what a connection serves (PRDCT-4424,
 * PRDCT-4552): Codex's own list, asked of the CLI, and a machine's models
 * catalogue (models.dev, as that machine keeps it), read for every company of
 * the provider catalogue at once. The launcher keeps its own reads
 * (`models-catalog-store`); these are the settings pages', so neither asks
 * the other's question again.
 */
import { useEffect, useState } from 'react'
import type { ModelOption } from '../../../../shared/session-model'
import type { ModelsCatalogView } from '@clave/contract/settings/models-catalog-view'
import { PROVIDER_LISTING_FACTS } from '../../../../main/models-catalog-overlay'
import { useWorkspaceStore } from '../../store/workspace-store'

/** The folder Codex is asked its models from: the active workspace's root,
 *  else the home folder the walk knows. */
async function modelsFolder(): Promise<string> {
  const { workspaces, activeWorkspaceId } = useWorkspaceStore.getState()
  const root = workspaces.find((w) => w.id === activeWorkspaceId)?.rootDir
  if (root) return root
  const state = await window.electronAPI.onboardingGetState?.().catch(() => null)
  return state?.home ?? '/'
}

/** Codex's models, asked of the CLI once when `enabled` first holds. */
export function useCodexModels(enabled: boolean): {
  models: ModelOption[] | null
  failed: boolean
} {
  const [models, setModels] = useState<ModelOption[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      try {
        const list = await window.electronAPI.adaptersModels('codex-chat', await modelsFolder())
        if (cancelled) return
        if (Array.isArray(list) && list.length > 0) setModels(list)
        else setFailed(true)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled])
  return { models, failed }
}

/** Every models.dev provider id the catalogue's companies map to. */
export const CATALOG_PROVIDER_IDS: readonly string[] = [
  ...new Set(
    Object.values(PROVIDER_LISTING_FACTS)
      .map((facts) => facts.catalog)
      .filter((id): id is string => !!id)
  )
]

/** A catalogue is read again after an hour, as the launcher's. */
const FRESH_MS = 60 * 60_000

const cache = new Map<string, { view: ModelsCatalogView; at: number }>()

export type PageCatalog = ModelsCatalogView | 'loading' | null

/** A machine's models catalogue for the settings page: `'loading'` until it
 *  lands, null when none could be read. Read once an hour per machine. */
export function useMachineCatalog(machine: string): PageCatalog {
  const [state, setState] = useState<{ machine: string; view: PageCatalog } | null>(null)
  useEffect(() => {
    const hit = cache.get(machine)
    if (hit && Date.now() - hit.at < FRESH_MS) return
    let cancelled = false
    void window.electronAPI
      .fleetModelsCatalog(machine, { providerIds: [...CATALOG_PROVIDER_IDS] })
      .then((view) => {
        if (cancelled) return
        const usable = view && Array.isArray(view.providers) && view.providers.length > 0
        if (usable) cache.set(machine, { view, at: Date.now() })
        setState({ machine, view: usable ? view : null })
      })
      .catch(() => {
        if (!cancelled) setState({ machine, view: hit?.view ?? null })
      })
    return () => {
      cancelled = true
    }
  }, [machine])
  const hit = cache.get(machine)
  if (state?.machine === machine && state.view !== 'loading') return hit?.view ?? state.view
  return hit?.view ?? 'loading'
}

/** Test seam: forget every read. */
export function resetMachineCatalogs(): void {
  cache.clear()
}
