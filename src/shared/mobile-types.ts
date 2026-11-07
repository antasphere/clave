/**
 * The phones paired with a Clave server, as the windows see them (mobile
 * wave, lane A): the read models of `packages/contract/src/devices.ts`,
 * repeated here so the preload's typed bridge and the renderer never import
 * the contract module, whose HTTP group pulls the framework's server-side
 * packages into the window's typecheck. `packages/contract/src/devices.test.ts`
 * holds the two copies together: a field added on one side fails there.
 * Nothing here can sign a request: no session token, no push token.
 */

export type DevicePlatform = 'ios' | 'android'

/** A paired phone. */
export interface DeviceView {
  id: string
  name: string
  platform: DevicePlatform
  appVersion: string
  /** Epoch milliseconds, the server's clock. */
  createdAt: number
  /** The last authenticated call, recorded at most once a minute; null before the first. */
  lastSeenAt: number | null
}

/** A phone waiting for the owner's word. */
export interface PendingPairingView {
  id: string
  name: string
  platform: DevicePlatform
  appVersion: string
  requestedAt: number
  /** When the request lapses unanswered. */
  expiresAt: number
}

/** What the owner's list carries. */
export interface DevicesView {
  /** Bumped on every change; the `devices.changed` event carries it. */
  revision: number
  devices: DeviceView[]
  pending: PendingPairingView[]
}
