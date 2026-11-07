/**
 * The devices port: what the server needs from whoever runs it to admit a
 * phone as its owner's (the spec "Clave on the phone", decision 3; issue
 * #281). The entry gives the document the device records live in, the
 * owner's identity (the Antasphere login made on this very server), the
 * issuer override of its environment, its own name, the preference the
 * relay address is kept in, and what to do when a phone asks (the Mac
 * shows a notification; a daemon writes a line). Nothing of the hub is
 * reached through this port: the keys are fetched by the domain itself.
 */
import { Context, Layer } from 'effect'
import type { DevicePlatform } from '@clave/contract/devices'

export type Awaitable<T> = T | Promise<T>

/** One document, `devices.json`, read whole and replaced whole; the adapter
 *  owns its mode (0600, like `server-connections.json`). */
export interface DeviceDocumentStorage {
  /** The document's text, or null when there is none yet. A read that fails
   *  for any other reason throws, and the store then admits no phone. */
  read(): string | null
  write(text: string): void
}

/** The relay address preference (`mobileRelayUrl`), stored here and read by
 *  the relay client; the server validates it as an http(s) origin before it
 *  lands. Absent, the address is unavailable on this server. */
export interface RelayAddressPreference {
  get(): string
  set(url: string): void
}

export interface DevicesPortService {
  readonly storage: DeviceDocumentStorage
  /** The subject of the Antasphere account signed in on this server, read
   *  at every pairing request; null while nobody is. A server with no
   *  owner admits no phone, whatever the token. */
  readonly owner: () => Awaitable<string | null>
  /** The raw `CLAVE_ANTASPHERE_ISSUER` of the entry's environment: absent,
   *  the hub; a loopback test provider otherwise. Validated by the domain
   *  with the account manager's own rule; refused, every token is refused. */
  readonly issuer: string | undefined
  /** How this server names itself to a phone (the Mac's hostname). */
  readonly serverName: () => string
  readonly relay?: RelayAddressPreference
  /** A phone asked to pair: the Mac shows a notification when no window is
   *  focused, a daemon writes a line. Never the token. */
  readonly onPairingRequested?: (pairing: {
    readonly name: string
    readonly platform: DevicePlatform
  }) => void
  /** The network and the clock, each replaceable in a test. */
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

export class DevicesPort extends Context.Tag('@clave/server/DevicesPort')<
  DevicesPort,
  DevicesPortService
>() {
  static layer(service: DevicesPortService): Layer.Layer<DevicesPort> {
    return Layer.succeed(DevicesPort, service)
  }
  /** A server with no devices behind it: no owner, so every pairing is
   *  refused as unavailable, and a document kept in memory that nothing
   *  ever reaches. The tests' default. */
  static readonly none: DevicesPortService = {
    storage: memoryDeviceStorage(),
    owner: () => null,
    issuer: undefined,
    serverName: () => 'clave'
  }
}

/** A document kept in memory: the tests', and the port's `none`. */
export function memoryDeviceStorage(initial: string | null = null): DeviceDocumentStorage {
  let text = initial
  return {
    read: () => text,
    write: (next) => {
      text = next
    }
  }
}
