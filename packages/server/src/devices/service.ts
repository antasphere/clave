/**
 * The devices domain composed: the store over the port's document, the
 * pairings in flight, the owner's proof against the hub's keys, the
 * phone's reach, and the one revision every change bumps. Built once per
 * server from the port (`DevicesPort`) and the server's id; the token check
 * asks it who a credential belongs to, the push hub asks it the same and
 * hears the revocations, the handlers do the rest through it.
 */
import { Context, Effect, Layer } from 'effect'
import { CapabilityUnavailable } from '@clave/contract/errors'
import {
  DeviceNotFound,
  DevicePairingNotFound,
  DevicePairingRefused,
  RelayAddressInvalid,
  type DeviceDescription,
  type DevicePlatform,
  type DeviceSessionView,
  type DeviceView,
  type DevicesView,
  type PairingStatus
} from '@clave/contract/devices'
import { DevicesPort, type DevicesPortService } from './port'
import {
  IdentityTokenRefused,
  JwksCache,
  OwnerMissing,
  resolveAntasphereIssuer,
  verifyIdentityToken,
  type IssuerConfig
} from './identity-token'
import { DeviceStore, type StoredDevice } from './store'
import { PairingDesk } from './pairings'
import { devicesPushTargets, type PushTargets } from './push-targets'

export type Unsubscribe = () => void

export interface PairingRequestInput {
  readonly idToken: string
  readonly clientId: string
  readonly device: DeviceDescription
}

export interface DeviceSessionsService {
  /** The phone a presented credential belongs to, or null. */
  readonly authenticate: (presented: string) => { readonly deviceId: string } | null
  /** The phone made an authenticated call; its last-seen time, once a minute. */
  readonly touch: (deviceId: string) => void
  /** Told of every revocation, for the sockets to close. */
  readonly onRevoked: (listener: (deviceId: string) => void) => Unsubscribe
  /** Told of every change, with the revision, for the `devices.changed` event. */
  readonly subscribe: (listener: (revision: number) => void) => Unsubscribe
  /** Told of every phone that asked, for the `devices.pairing_requested` event. */
  readonly onPairingRequested: (
    listener: (pairing: { pairingId: string; name: string; platform: DevicePlatform }) => void
  ) => Unsubscribe
  readonly requestPairing: (
    input: PairingRequestInput
  ) => Promise<{ pairingId: string; expiresAt: number }>
  readonly readPairing: (id: string) => {
    status: PairingStatus
    deviceSession?: DeviceSessionView
  }
  readonly list: () => DevicesView
  readonly approve: (pairingId: string) => DeviceView
  readonly refuse: (pairingId: string) => void
  readonly revoke: (deviceId: string) => void
  readonly me: (deviceId: string) => DeviceView
  readonly setPushToken: (deviceId: string, token: string, platform: DevicePlatform) => void
  readonly clearPushToken: (deviceId: string) => void
  readonly relay: { readonly get: () => string; readonly set: (url: string) => string }
  /** Lane B's seam. */
  readonly pushTargets: PushTargets
}

export class DeviceSessions extends Context.Tag('@clave/server/DeviceSessions')<
  DeviceSessions,
  DeviceSessionsService
>() {
  static layer(options: { serverId: string }): Layer.Layer<DeviceSessions, never, DevicesPort> {
    return Layer.effect(
      DeviceSessions,
      Effect.map(DevicesPort, (port) => makeDeviceSessions(port, options))
    )
  }
}

/** The relay address as it is kept: an http(s) origin and nothing more, or empty. */
export function normalizeRelayUrl(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new RelayAddressInvalid({ message: 'Enter the relay address as an http(s) origin.' })
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new RelayAddressInvalid({
      message:
        'Enter the relay address as an http(s) origin, without a path, a query or credentials.'
    })
  return url.origin
}

const view = (device: StoredDevice): DeviceView => ({
  id: device.id,
  name: device.name,
  platform: device.platform,
  appVersion: device.appVersion,
  createdAt: device.createdAt,
  lastSeenAt: device.lastSeenAt
})

export function makeDeviceSessions(
  port: DevicesPortService,
  options: { serverId: string }
): DeviceSessionsService {
  const now = port.now ?? Date.now
  const store = new DeviceStore(port.storage, now)
  const desk = new PairingDesk(now)
  const resolved = resolveAntasphereIssuer(port.issuer)
  const issuer: IssuerConfig | null = resolved.ok ? resolved.config : null
  const keys = issuer
    ? new JwksCache({
        issuer: issuer.issuer,
        ...(port.fetch && { fetch: port.fetch }),
        now
      })
    : null
  // The revision a client compares lists by. It starts at the clock, not at
  // zero: a server restarted while a window is open hands out revisions above
  // the ones the window already applied, so its lists are never ignored.
  let revision = now()
  const changeListeners = new Set<(revision: number) => void>()
  const revokedListeners = new Set<(deviceId: string) => void>()
  const askedListeners = new Set<
    (pairing: { pairingId: string; name: string; platform: DevicePlatform }) => void
  >()
  const changed = (): void => {
    revision += 1
    for (const listener of [...changeListeners]) {
      try {
        listener(revision)
      } catch (error) {
        console.error('[clave-server] devices listener failed', error)
      }
    }
  }
  const server = (): { id: string; name: string } => ({
    id: options.serverId,
    name: port.serverName()
  })

  return {
    authenticate: (presented) => {
      const device = store.authenticate(presented)
      return device ? { deviceId: device.id } : null
    },
    touch: (deviceId) => {
      if (store.touch(deviceId)) changed()
    },
    onRevoked: (listener) => {
      revokedListeners.add(listener)
      return () => {
        revokedListeners.delete(listener)
      }
    },
    subscribe: (listener) => {
      changeListeners.add(listener)
      return () => {
        changeListeners.delete(listener)
      }
    },
    onPairingRequested: (listener) => {
      askedListeners.add(listener)
      return () => {
        askedListeners.delete(listener)
      }
    },
    requestPairing: async (input) => {
      // The owner first, before anything is fetched: a signed-out server
      // never calls the hub on a stranger's say-so.
      const ownerSubject = await port.owner()
      if (ownerSubject === null)
        throw new CapabilityUnavailable({
          capability: 'devices',
          message: 'This server has no Antasphere login, so no phone can pair with it.'
        })
      if (!issuer || !keys)
        throw new CapabilityUnavailable({
          capability: 'configuration',
          message: 'The Antasphere issuer configured for this server is refused; no phone can pair.'
        })
      try {
        await verifyIdentityToken({
          token: input.idToken,
          clientId: input.clientId,
          ownerSubject,
          issuer,
          keys,
          now
        })
      } catch (error) {
        if (error instanceof IdentityTokenRefused)
          throw new DevicePairingRefused({ check: error.check, message: error.message })
        if (error instanceof OwnerMissing)
          throw new CapabilityUnavailable({ capability: 'devices', message: error.message })
        throw error
      }
      const pairing = desk.request(ownerSubject, input.device)
      if (!pairing)
        throw new DevicePairingRefused({
          check: 'busy',
          message: 'Too many phones are waiting for an answer; try again in a few minutes.'
        })
      const asked = {
        pairingId: pairing.pairingId,
        name: input.device.name,
        platform: input.device.platform
      }
      port.onPairingRequested?.({ name: asked.name, platform: asked.platform })
      for (const listener of [...askedListeners]) {
        try {
          listener(asked)
        } catch (error) {
          console.error('[clave-server] pairing listener failed', error)
        }
      }
      changed()
      return pairing
    },
    readPairing: (id) => desk.read(id),
    list: () => ({ revision, devices: store.list(), pending: desk.pending() }),
    approve: (pairingId) => {
      const device = desk.approve(pairingId, (description) => store.create(description), server())
      if (!device)
        throw new DevicePairingNotFound({
          id: pairingId,
          message: 'This pairing request is no longer waiting: it was answered or it lapsed.'
        })
      changed()
      return view(device)
    },
    refuse: (pairingId) => {
      if (!desk.refuse(pairingId))
        throw new DevicePairingNotFound({
          id: pairingId,
          message: 'This pairing request is no longer waiting: it was answered or it lapsed.'
        })
      changed()
    },
    revoke: (deviceId) => {
      if (!store.revoke(deviceId))
        throw new DeviceNotFound({
          id: deviceId,
          message: 'This phone is no longer paired with this server.'
        })
      for (const listener of [...revokedListeners]) {
        try {
          listener(deviceId)
        } catch (error) {
          console.error('[clave-server] device revocation listener failed', error)
        }
      }
      changed()
    },
    me: (deviceId) => {
      const device = store.get(deviceId)
      if (!device)
        throw new DeviceNotFound({
          id: deviceId,
          message: 'This phone is no longer paired with this server.'
        })
      return view(device)
    },
    setPushToken: (deviceId, token, platform) => {
      if (!store.setPushToken(deviceId, token, platform))
        throw new DeviceNotFound({
          id: deviceId,
          message: 'This phone is no longer paired with this server.'
        })
      changed()
    },
    clearPushToken: (deviceId) => {
      if (!store.get(deviceId))
        throw new DeviceNotFound({
          id: deviceId,
          message: 'This phone is no longer paired with this server.'
        })
      if (store.clearPushToken(deviceId)) changed()
    },
    relay: {
      get: () => port.relay?.get() ?? '',
      set: (url) => {
        if (!port.relay)
          throw new CapabilityUnavailable({
            capability: 'relay',
            message: 'This server keeps no relay address.'
          })
        const normalized = normalizeRelayUrl(url)
        port.relay.set(normalized)
        changed()
        return normalized
      }
    },
    pushTargets: devicesPushTargets(store)
  }
}
