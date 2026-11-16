/**
 * The relay client's state as Settings → Mobile reads it (issue #407): the
 * renderer's copy of `MobileRelayStatus` in `@clave/contract/devices`, which
 * the window cannot import (the contract module brings the HTTP framework,
 * and with it Bun's types, into the web typecheck).
 * `mobile-relay-types.test.ts` holds the two copies together.
 */
export const MOBILE_RELAY_STATES = [
  'off',
  'signed-out',
  'claiming',
  'connecting',
  'connected',
  'waiting',
  'refused'
] as const

export type MobileRelayState = (typeof MOBILE_RELAY_STATES)[number]

export interface MobileRelayStatus {
  readonly state: MobileRelayState
  /** The address the client is using, or null. */
  readonly relay: string | null
  /** The machine id the relay knows this server by, once claimed. */
  readonly machineId: string | null
  /** Epoch milliseconds the state was entered. */
  readonly since: number
  /** The client's own sentence for its last failure; never a token. */
  readonly lastFailure: string | null
}
