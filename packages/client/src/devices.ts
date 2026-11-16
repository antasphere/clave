/**
 * The devices domain of the typed client, as far as the Mac's Settings →
 * Mobile needs it on dev (issue #407): the relay address this server keeps
 * and the state of its relay client. The phone's own calls (pairing, its
 * record, its push token) stay with the phones, which use their platform's
 * fetch on the same routes.
 */
import type { MobileRelayStatus } from '@clave/contract/devices'
import type { Call } from './call'

export interface DevicesClient {
  readonly relay: {
    /** The address this server keeps; empty when none. */
    readonly get: () => Promise<string>
    /** Keep an address (empty clears it); answers it as the server kept it. */
    readonly set: (url: string) => Promise<string>
    /** Where the relay client stands now. */
    readonly status: () => Promise<MobileRelayStatus>
  }
}

export const devicesClient = (call: Call): DevicesClient => ({
  relay: {
    get: () => call((c) => c.devices.readRelay({ payload: {} })).then((r) => r.url),
    set: (url) => call((c) => c.devices.setRelay({ payload: { url } })).then((r) => r.url),
    status: () => call((c) => c.devices.readRelayStatus({ payload: {} }))
  }
})
