/**
 * The relay client wired into a Clave server (lane E of the mobile wave,
 * decision 4 of the mobile spec): what the server package's client needs of
 * the process it runs in, and nothing the package can know on its own.
 *
 *  - the relay's address: the standalone entry's `--relay` flag when given,
 *    the `mobileRelayUrl` preference otherwise, read again at every attempt
 *    so an address saved in Settings → Mobile takes effect without a restart.
 *    The preference is declared by the lane that owns the preferences
 *    contract; this side reads it by name and refuses anything that is not
 *    an http(s) address.
 *  - the owner: the Antasphere account manager of this process (the shell's
 *    while the server runs in-process, the standalone entry's otherwise),
 *    its subject for the credential's binding and `currentAccessToken()`
 *    for the claim.
 *  - the credential: `relay.json` under the data directory, the machine
 *    secret sealed through the secrets port (Electron's `safeStorage` in the
 *    app, the Keychain or the encrypted files for a standalone server), the
 *    plain half carrying the relay address, the machine id and the owner.
 *  - the record: the host's name, the platform, the app's version, and the
 *    addresses a phone may try before the relay (a daemon's own, when it
 *    binds a host that is not loopback; none for the in-process and the
 *    separate server, whose listener is loopback).
 *
 * Loaded on first use by the shell (a dynamic import in `clave-server.ts`,
 * so main's boot reaches no Effect module through it), statically by the
 * standalone entry, which runs the server package anyway.
 */
import * as os from 'node:os'
import {
  insecureRelayAddress,
  startRelayClient,
  type RelayClient,
  type RelayCredential,
  type RelayCredentialStore
} from '@clave/server'
import type { MachineRecord } from '@clave/contract/relay'
import { lazySettingsPorts, type SettingsPorts } from '../ports/registry'
import { readJson, writeJson } from '../ports/storage'
import type { AntasphereAccountManager } from '../antasphere-account'
import { preferencesManager, type PreferencesManager } from '../preferences-manager'

export const RELAY_FILE = 'relay.json'
/** The preference naming the relay, declared in the preferences contract by
 *  the lane that owns it (Settings → Mobile). */
export const MOBILE_RELAY_PREFERENCE = 'mobileRelayUrl'

interface RelayFile {
  v: 1
  relay: string
  machineId: string
  owner: string
  sealed: string
  claimedAt: number
}

/** A relay address as this side accepts it: an https URL, or plain http to
 *  a literal loopback address (the development relay, the test provider's
 *  machine), with no credentials, no query and no fragment, its trailing
 *  slash dropped; null for anything else. The client applies the same rule
 *  again where a claim or a hello would leave (`insecureRelayAddress`). */
export function relayAddressOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (insecureRelayAddress(text) !== null) return null
  if (url.username || url.password || url.search || url.hash) return null
  return url.toString().replace(/\/+$/, '')
}

/** The relay address the preferences name, or null. */
export function readMobileRelayPreference(
  manager: PreferencesManager = preferencesManager
): string | null {
  // Read by name: the key belongs to the preferences contract of the lane
  // that owns Settings → Mobile, and a preferences file without it answers
  // nothing, which is "no relay".
  const value = (manager as unknown as { get(key: string): unknown }).get(MOBILE_RELAY_PREFERENCE)
  return relayAddressOf(value)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function readRelayFile(value: unknown): RelayFile | null {
  if (!isRecord(value) || value.v !== 1) return null
  if (typeof value.relay !== 'string' || typeof value.machineId !== 'string') return null
  if (typeof value.owner !== 'string' || typeof value.sealed !== 'string') return null
  return {
    v: 1,
    relay: value.relay,
    machineId: value.machineId,
    owner: value.owner,
    sealed: value.sealed,
    claimedAt: typeof value.claimedAt === 'number' ? value.claimedAt : 0
  }
}

/** The credential store over the settings ports: the secret sealed on the
 *  way out, the previous item discarded when a new one replaces it. */
export function relayCredentialStore(
  ports: SettingsPorts = lazySettingsPorts,
  log: (line: string) => void = () => {}
): RelayCredentialStore {
  const current = (): RelayFile | null => readRelayFile(readJson(ports.storage, RELAY_FILE))
  return {
    load(): RelayCredential | null {
      const file = current()
      if (!file) return null
      let opened: string | undefined
      try {
        opened = ports.secrets.open(file.sealed)
      } catch {
        opened = undefined
      }
      if (opened === undefined) {
        log('relay: the stored machine credential cannot be opened here, claiming anew')
        return null
      }
      return {
        relay: file.relay,
        machineId: file.machineId,
        owner: file.owner,
        machineSecret: opened
      }
    },
    save(credential: RelayCredential): void {
      if (!ports.secrets.available())
        throw new Error('OS encryption is unavailable: the machine credential cannot be kept')
      const previous = current()
      const sealed = ports.secrets.seal(credential.machineSecret)
      const file: RelayFile = {
        v: 1,
        relay: credential.relay,
        machineId: credential.machineId,
        owner: credential.owner,
        sealed,
        claimedAt: Date.now()
      }
      writeJson(ports.storage, RELAY_FILE, file, { mode: 0o600 })
      if (previous && previous.sealed !== sealed) {
        try {
          ports.secrets.discard(previous.sealed)
        } catch {
          /* nothing to forget */
        }
      }
    },
    clear(): void {
      const previous = current()
      ports.storage.remove(RELAY_FILE)
      if (previous) {
        try {
          ports.secrets.discard(previous.sealed)
        } catch {
          /* nothing to forget */
        }
      }
    }
  }
}

/** The record this process presents: the host's name (without the `.local`
 *  macOS appends), the platform, the version, the direct addresses. */
export function machineRecord(input: {
  version: string
  direct?: ReadonlyArray<string>
  hostname?: string
  platform?: NodeJS.Platform
}): MachineRecord {
  const platform = input.platform ?? process.platform
  const host = (input.hostname ?? os.hostname()).replace(/\.local$/i, '').trim()
  return {
    name: host || 'Clave',
    platform: platform === 'darwin' ? 'macos' : 'linux',
    version: input.version,
    direct: (input.direct ?? []).map((url) => ({ url }))
  }
}

export interface MobileRelayWiring {
  /** The server's own listener, where forwarded requests are performed. */
  readonly local: { readonly url: string }
  /** The version the record names. */
  readonly version: string
  /** The `--relay` flag, when the entry was given one; the preference otherwise. */
  readonly flag?: string | null
  /** The process's Antasphere account manager; null attached to a server elsewhere. */
  readonly antasphere: AntasphereAccountManager | null
  /** The addresses a phone may try before the relay. */
  readonly direct?: ReadonlyArray<string>
  readonly ports?: SettingsPorts
  readonly log?: (line: string) => void
}

let running: RelayClient | null = null

/** Start the relay client for this server; the one before, if any, is
 *  stopped first. Answers null on a platform the client does not run on. */
export function startMobileRelay(wiring: MobileRelayWiring): RelayClient | null {
  const log = wiring.log ?? ((line: string) => console.log(`[mobile-relay] ${line}`))
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    log('relay: the relay client runs on macOS and Linux only; this server stays off the relay')
    return null
  }
  const previous = running
  if (previous) void previous.stop()
  const flag = relayAddressOf(wiring.flag)
  const manager = wiring.antasphere
  const client = startRelayClient({
    address: () => flag ?? readMobileRelayPreference(),
    owner: () => manager?.status().account?.subject ?? null,
    accessToken: () => (manager ? manager.currentAccessToken() : Promise.resolve(null)),
    record: () => machineRecord({ version: wiring.version, direct: wiring.direct ?? [] }),
    credentials: relayCredentialStore(wiring.ports, log),
    local: { url: wiring.local.url },
    log
  })
  running = client
  // The login changing is what the client waits on most: a sign-out takes
  // the machine off the relay now, a sign-in puts it back now.
  const offChange = manager?.onChange(() => client.kick())
  if (offChange) {
    const stop = client.stop.bind(client)
    client.stop = async () => {
      offChange()
      await stop()
    }
  }
  return client
}

/** The relay client's state, for whoever shows it; null when none runs. */
export function mobileRelayStatus(): ReturnType<RelayClient['status']> | null {
  return running?.status() ?? null
}

/** Stop the running client, if any. Idempotent. */
export async function stopMobileRelay(): Promise<void> {
  const client = running
  running = null
  if (client) await client.stop()
}
