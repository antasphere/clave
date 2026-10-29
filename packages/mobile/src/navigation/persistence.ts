/**
 * Where the app opens. A fresh launch opens Machines then Workspaces of the
 * machine last used; coming back to the foreground restores the screen the
 * person was on. The platform keeps the screen tree while the app is merely
 * in the background; this file covers the case where it was evicted there:
 * the navigation state is saved when the app leaves the foreground and
 * restored on the next launch when that save is recent (RESTORE_WINDOW_MS),
 * which is the one signal that tells a return from a fresh start.
 */
export interface SavedNavigation {
  readonly state: unknown
  readonly savedAt: number
  readonly machineId: string | null
}

export const NAVIGATION_KEY = 'clave.navigation'
export const LAST_MACHINE_KEY = 'clave.last-machine'
export const RESTORE_WINDOW_MS = 30 * 60_000

export type InitialNavigation =
  | { readonly kind: 'restore'; readonly state: unknown }
  | { readonly kind: 'fresh'; readonly state: unknown }

export const freshState = (machineId: string | null): unknown =>
  machineId
    ? { index: 1, routes: [{ name: 'Machines' }, { name: 'Workspaces', params: { machineId } }] }
    : { index: 0, routes: [{ name: 'Machines' }] }

export function decideInitialNavigation(
  saved: SavedNavigation | null,
  now: number,
  lastMachineId: string | null,
  windowMs = RESTORE_WINDOW_MS
): InitialNavigation {
  if (saved && saved.state && now - saved.savedAt >= 0 && now - saved.savedAt < windowMs)
    return { kind: 'restore', state: saved.state }
  return { kind: 'fresh', state: freshState(lastMachineId) }
}

export function parseSaved(raw: string | null): SavedNavigation | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as SavedNavigation).savedAt === 'number' &&
      'state' in parsed
    )
      return {
        state: (parsed as SavedNavigation).state,
        savedAt: (parsed as SavedNavigation).savedAt,
        machineId:
          typeof (parsed as SavedNavigation).machineId === 'string'
            ? (parsed as SavedNavigation).machineId
            : null
      }
  } catch {
    /* an unreadable save is no save */
  }
  return null
}

/** The machine the saved screen tree is on, read off the deepest route that names one. */
export function machineIdOf(state: unknown): string | null {
  const routes = (state as { routes?: { params?: { machineId?: unknown } }[] } | null)?.routes
  if (!Array.isArray(routes)) return null
  for (let i = routes.length - 1; i >= 0; i--) {
    const id = routes[i]?.params?.machineId
    if (typeof id === 'string') return id
  }
  return null
}
