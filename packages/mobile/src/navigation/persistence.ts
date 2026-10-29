/**
 * Where the app opens (the interview's rule, as the wave restated it on 29
 * October 2026). A warm resume from the background keeps the navigator the
 * process already holds: there is nothing to restore. A cold launch, a new
 * process, opens the Workspaces of the current machine, with no machine
 * picker when a machine is already paired or selected, and Machines alone
 * when none is. A notification tap is a deep link to its conversation on
 * either path (`clave://chat/<machineId>/<sessionId>`, the route this file
 * builds; lane D wires the notifications). Elapsed time is never the signal
 * of how the app was closed: iOS gives no way to tell a person's force-close
 * from an eviction, so every new process is a cold launch there; Android
 * may hand back saved instance state after a process death, which this app
 * does not read yet, so a new process is a cold launch there too.
 */
export const LAST_MACHINE_KEY = 'clave.last-machine'

export interface RouteState {
  readonly index: number
  readonly routes: readonly { readonly name: string; readonly params?: Record<string, string> }[]
}

/** A cold launch: Machines, then the Workspaces of the current machine. */
export const coldLaunchState = (machineId: string | null): RouteState =>
  machineId
    ? { index: 1, routes: [{ name: 'Machines' }, { name: 'Workspaces', params: { machineId } }] }
    : { index: 0, routes: [{ name: 'Machines' }] }

/** The conversation a deep link names, over its machine's Workspaces and
 *  Sessions-less stack: back from the chat goes to the machine's workspaces. */
export const deepLinkState = (machineId: string, sessionId: string): RouteState => ({
  index: 2,
  routes: [
    { name: 'Machines' },
    { name: 'Workspaces', params: { machineId } },
    { name: 'Chat', params: { machineId, sessionId } }
  ]
})

/** The path of a deep link to a conversation: `chat/<machineId>/<sessionId>`. */
export const chatPath = (machineId: string, sessionId: string): string =>
  `chat/${encodeURIComponent(machineId)}/${encodeURIComponent(sessionId)}`

/**
 * The state a URL opens, for the navigation container's linking config:
 * `clave://chat/<machineId>/<sessionId>` (or the same path without the
 * scheme) opens that conversation on a cold start and on a warm one alike;
 * anything else is not a link this app knows, and the container keeps its
 * own state.
 */
export function stateForPath(path: string): RouteState | undefined {
  const clean =
    path
      .replace(/^[a-z]+:\/\//i, '')
      .replace(/^\/+/, '')
      .split(/[?#]/)[0] ?? ''
  const parts = clean.split('/').filter(Boolean)
  if (parts.length === 3 && parts[0] === 'chat') {
    const machineId = decode(parts[1])
    const sessionId = decode(parts[2])
    if (machineId && sessionId) return deepLinkState(machineId, sessionId)
  }
  return undefined
}

const decode = (part: string | undefined): string | null => {
  if (!part) return null
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

/** The machine of a screen tree, read off the deepest route that names one. */
export function machineIdOf(state: unknown): string | null {
  const routes = (state as { routes?: { params?: { machineId?: unknown } }[] } | null)?.routes
  if (!Array.isArray(routes)) return null
  for (let i = routes.length - 1; i >= 0; i--) {
    const id = routes[i]?.params?.machineId
    if (typeof id === 'string') return id
  }
  return null
}
