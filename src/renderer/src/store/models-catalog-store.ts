/**
 * What the launcher lists under Pi and OpenCode for a provider connection
 * (PRDCT-4496): the models catalogue of each machine, and each stored
 * connection's usage line. One entry per machine (`LOCAL_SERVER_ID` for this
 * Mac, else the saved server's id), so a "Run on <server>" section lists what
 * THAT server's catalogue says. The launcher triggers the reads when its menu
 * opens (`ensureModelsCatalog`, `ensureUsageLine`); the launch sources read
 * the result at render (`modelsCatalogFor`, `usageLineTextFor`), and the
 * launcher's subscription to these stores is what redraws the menu.
 *
 * The reader is passed in, so this module carries no IPC of its own and is
 * tested without a window.
 */
import { create } from 'zustand'
import type { ModelsCatalogView } from '@clave/contract/settings/models-catalog-view'
import {
  usageLineText,
  type ProviderUsageLineView
} from '@clave/contract/settings/provider-usage-view'

/** A machine's catalogue is read again after an hour. */
export const CATALOG_FRESH_MS = 60 * 60_000
/** A connection's usage line is read again after five minutes. */
export const USAGE_LINE_FRESH_MS = 5 * 60_000

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'failed'

export interface CatalogEntry {
  /** The last catalogue read; kept through a failed read after it. */
  view: ModelsCatalogView | null
  status: CatalogStatus
  /** When the last read settled, or null before the first. */
  readAt: number | null
  /** What the read asked for (the provider ids): a different ask reads again. */
  key: string
}

export const useModelsCatalogStore = create<{ byMachine: Record<string, CatalogEntry> }>(() => ({
  byMachine: {}
}))

const catalogInFlight = new Map<string, Promise<void>>()

/** Read a machine's catalogue unless it is fresh: once per machine, again
 *  after an hour or when `key` (what the read asks for) changed, never twice
 *  at once. A failed read keeps the copy before it and is tried again on the
 *  next call. */
export function ensureModelsCatalog(
  machineId: string,
  read: () => Promise<ModelsCatalogView>,
  key = ''
): Promise<void> {
  const pending = catalogInFlight.get(machineId)
  if (pending) return pending
  const entry = useModelsCatalogStore.getState().byMachine[machineId]
  if (
    entry?.status === 'ready' &&
    entry.key === key &&
    entry.readAt !== null &&
    Date.now() - entry.readAt < CATALOG_FRESH_MS
  )
    return Promise.resolve()
  const set = (next: Partial<CatalogEntry>): void => {
    const state = useModelsCatalogStore.getState().byMachine
    const current = state[machineId] ?? { view: null, status: 'idle', readAt: null, key }
    useModelsCatalogStore.setState({
      byMachine: { ...state, [machineId]: { ...current, ...next } }
    })
  }
  set({ status: 'loading', key })
  const run = (async () => {
    try {
      const view = await Promise.resolve().then(read)
      set({ view, status: 'ready', readAt: Date.now(), key })
    } catch {
      set({ status: 'failed', readAt: Date.now() })
    } finally {
      catalogInFlight.delete(machineId)
    }
  })()
  catalogInFlight.set(machineId, run)
  return run
}

/** A machine's catalogue entry, or undefined before the first ask. */
export function modelsCatalogFor(machineId: string): CatalogEntry | undefined {
  return useModelsCatalogStore.getState().byMachine[machineId]
}

export interface UsageLineEntry {
  line: ProviderUsageLineView | null
  readAt: number | null
}

const lineKey = (machineId: string, connectionId: string): string =>
  `${machineId}\u0000${connectionId}`

export const useUsageLineStore = create<{ byConnection: Record<string, UsageLineEntry> }>(() => ({
  byConnection: {}
}))

const lineInFlight = new Map<string, Promise<void>>()

/** Read a connection's usage line unless it was read in the last five
 *  minutes, never twice at once. The roads answer an unknown line rather
 *  than reject; a rejection anyway is kept as the unknown line. */
export function ensureUsageLine(
  machineId: string,
  connectionId: string,
  read: () => Promise<ProviderUsageLineView>
): Promise<void> {
  const key = lineKey(machineId, connectionId)
  const pending = lineInFlight.get(key)
  if (pending) return pending
  const entry = useUsageLineStore.getState().byConnection[key]
  if (entry?.readAt != null && Date.now() - entry.readAt < USAGE_LINE_FRESH_MS)
    return Promise.resolve()
  const run = (async () => {
    let line: ProviderUsageLineView
    try {
      line = await Promise.resolve().then(read)
    } catch (error) {
      line = {
        kind: 'unknown',
        reason: error instanceof Error ? error.message : 'The read failed.'
      }
    } finally {
      lineInFlight.delete(key)
    }
    const state = useUsageLineStore.getState().byConnection
    useUsageLineStore.setState({
      byConnection: { ...state, [key]: { line, readAt: Date.now() } }
    })
  })()
  lineInFlight.set(key, run)
  return run
}

/** The line as the launcher's row says it, or null while it is not read yet. */
export function usageLineTextFor(machineId: string, connectionId: string): string | null {
  const line = useUsageLineStore.getState().byConnection[lineKey(machineId, connectionId)]?.line
  return line ? usageLineText(line) : null
}

/** Test seam: forget every read. */
export function resetModelsCatalogStores(): void {
  catalogInFlight.clear()
  lineInFlight.clear()
  useModelsCatalogStore.setState({ byMachine: {} })
  useUsageLineStore.setState({ byConnection: {} })
}
