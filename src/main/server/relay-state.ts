/**
 * The relay client this process runs, as the devices port reaches it (issue
 * #407): its state for Settings → Mobile and a nudge when the address is
 * saved. A module of its own that imports nothing, so the devices port (built
 * at every boot, in-process and standalone) stays as light as it was and
 * loads nothing of the server package; `relay-wiring.ts` registers the client
 * it starts and unregisters it when it stops.
 */
import type { RelayClient } from '@clave/server'

let current: RelayClient | null = null

/** The running client, or null once it stopped. */
export function setRunningRelayClient(client: RelayClient | null): void {
  current = client
}

/** The running client's state, or null when this process runs none. */
export function runningRelayStatus(): ReturnType<RelayClient['status']> | null {
  return current?.status() ?? null
}

/** Have the running client read the address and the login again now. */
export function kickRunningRelayClient(): void {
  current?.kick()
}
