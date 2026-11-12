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

/** A phone a credential belongs to; `suspended` while the account that approved it is not
 *  the one signed in on this server (signed out, or another account): refused, never revoked. */
export interface DeviceAuthentication {
  readonly deviceId: string
  readonly suspended: boolean
}

/** How often the owner is read again while a push channel listens for its changes. */
export const OWNER_POLL_MS = 1000

export interface DeviceSessionsService {
  /** The phone a presented credential belongs to, with the owner read now; null for an
   *  unknown credential and for a record bound to no owner (it pairs again). */
  readonly authenticate: (presented: string) => Promise<DeviceAuthentication | null>
  /** Whether the phone is suspended now, by the owner last read (the push channel's check). */
  readonly isSuspended: (deviceId: string) => boolean
  /** Told when the signed-in owner changes; while anyone listens it is read every second. */
  readonly onOwnerChanged: (listener: () => void) => Unsubscribe
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
  readonly readPairing: (id: string) => Promise<{
    status: PairingStatus
    deviceSession?: DeviceSessionView
  }>
  readonly list: () => Promise<DevicesView>
  readonly approve: (pairingId: string) => Promise<DeviceView>
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
  // ── PRDCT-4448: a phone is the account's that approved it. The owner is read fresh at
  // every pairing step and every authentication, and kept for the push channel's checks. ──
  let cachedOwner: string | null | undefined
  const ownerListeners = new Set<() => void>()
  let poll: ReturnType<typeof setInterval> | null = null
  const ownerNow = async (): Promise<string | null> => {
    let owner: string | null
    try {
      const read = await port.owner()
      owner = typeof read === 'string' && read !== '' ? read : null
    } catch {
      owner = null
    }
    const before = cachedOwner
    cachedOwner = owner
    if (before !== undefined && before !== owner)
      for (const listener of [...ownerListeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[clave-server] owner listener failed', error)
        }
      }
    return owner
  }

  return {
    authenticate: async (presented) => {
      const device = store.authenticate(presented)
      // Unknown, or bound to no owner (paired before the binding): it pairs again.
      if (!device || device.owner === undefined) return null
      const owner = await ownerNow()
      return { deviceId: device.id, suspended: owner === null || owner !== device.owner }
    },
    isSuspended: (deviceId) => {
      const device = store.get(deviceId)
      return (
        device === undefined ||
        device.owner === undefined ||
        cachedOwner === undefined ||
        cachedOwner === null ||
        device.owner !== cachedOwner
      )
    },
    onOwnerChanged: (listener) => {
      ownerListeners.add(listener)
      if (!poll) {
        poll = setInterval(() => void ownerNow(), OWNER_POLL_MS)
        poll.unref?.()
      }
      void ownerNow()
      return () => {
        ownerListeners.delete(listener)
        if (ownerListeners.size === 0 && poll) {
          clearInterval(poll)
          poll = null
        }
      }
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
      const ownerSubject = await ownerNow()
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
      // Read again: an account that changed while the keys were fetched gets nobody's phone.
      if ((await ownerNow()) !== ownerSubject)
        throw new DevicePairingRefused({
          check: 'subject',
          message: 'The Antasphere account on this server changed while the phone asked; ask again.'
        })
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
    readPairing: async (id) => desk.read(id, await ownerNow()),
    list: async () => {
      const owner = await ownerNow()
      return { revision, devices: store.listOf(owner), pending: desk.pending(owner) }
    },
    approve: async (pairingId) => {
      const owner = await ownerNow()
      const device = desk.approve(
        pairingId,
        (description, subject) => store.create(description, subject),
        server(),
        owner
      )
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
