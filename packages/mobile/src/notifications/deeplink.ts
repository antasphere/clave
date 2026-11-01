/**
 * Where a notification takes the app (decision 9 of the spec): a tap opens
 * the conversation it is about, on a cold launch (the app opens on it, not
 * on Workspaces) and on a warm resume alike; a request the notification
 * could not settle opens the app on that request; a notification about an
 * account opens the machine's workspaces. The notification names a server
 * and the phone reaches a server through a machine (a relay road, a direct
 * address), so the enrollment records resolve one to the other; a server
 * this phone is not paired with lands on Machines with the reason.
 *
 * The values are lane C's: the route names and params of its navigator
 * (`navigation/RootNavigator.tsx`) and the shape of its initial navigation
 * state (`navigation/persistence.ts`, `freshState`), so the wiring hands
 * `navigationStateOf` to the container on a cold launch and `routeOf` to
 * `navigate` on a warm one.
 */
import type { RootStackParamList } from '../navigation/RootNavigator'
import type { NotificationPayload } from './payload'

export type DeepLink =
  | {
      readonly kind: 'chat'
      readonly machineId: string
      readonly sessionId: string
      readonly title: string
    }
  | { readonly kind: 'requests'; readonly machineId: string; readonly requestId: string | null }
  | { readonly kind: 'workspaces'; readonly machineId: string }
  | { readonly kind: 'machines'; readonly reason: string }

/** The enrollment records, or anything that maps a server to a machine. */
export interface MachineResolver {
  byServerId(serverId: string): Promise<{ readonly machineId: string } | null>
}

export type DeepLinkTarget = 'conversation' | 'request'

export async function deepLinkOf(
  payload: NotificationPayload,
  machines: MachineResolver,
  target: DeepLinkTarget = 'conversation'
): Promise<DeepLink> {
  const record = await machines.byServerId(payload.serverId)
  if (!record)
    return {
      kind: 'machines',
      reason: `${payload.serverName || 'That machine'} is not paired with this phone.`
    }
  const { machineId } = record
  if (target === 'request' && payload.requestId)
    return { kind: 'requests', machineId, requestId: payload.requestId }
  if (payload.sessionId)
    return { kind: 'chat', machineId, sessionId: payload.sessionId, title: payload.sessionTitle }
  return { kind: 'workspaces', machineId }
}

type Route = {
  [K in keyof RootStackParamList]: RootStackParamList[K] extends undefined
    ? { readonly name: K; readonly params?: undefined }
    : { readonly name: K; readonly params: RootStackParamList[K] }
}[keyof RootStackParamList]

/** The screens under the deep link, root first: what a cold launch opens. */
export function routesOf(link: DeepLink): Route[] {
  switch (link.kind) {
    case 'machines':
      return [{ name: 'Machines' }]
    case 'workspaces':
      return [{ name: 'Machines' }, { name: 'Workspaces', params: { machineId: link.machineId } }]
    case 'requests':
      return [
        { name: 'Machines' },
        { name: 'Workspaces', params: { machineId: link.machineId } },
        {
          name: 'Requests',
          params: {
            machineId: link.machineId,
            ...(link.requestId ? { requestId: link.requestId } : {})
          }
        }
      ]
    case 'chat':
      return [
        { name: 'Machines' },
        { name: 'Workspaces', params: { machineId: link.machineId } },
        {
          name: 'Chat',
          params: {
            machineId: link.machineId,
            sessionId: link.sessionId,
            ...(link.title ? { title: link.title } : {})
          }
        }
      ]
  }
}

/** The navigation state a cold launch starts on, lane C's shape. */
export function navigationStateOf(link: DeepLink): { index: number; routes: Route[] } {
  const routes = routesOf(link)
  return { index: routes.length - 1, routes }
}

/** The one screen a warm resume navigates to. */
export function routeOf(link: DeepLink): Route {
  const routes = routesOf(link)
  return routes[routes.length - 1]!
}
