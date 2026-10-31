// ── Mobile wave, lane A: the devices, a phone paired with this server ──
export {
  DevicesPort,
  memoryDeviceStorage,
  type DevicesPortService,
  type DeviceDocumentStorage,
  type RelayAddressPreference
} from './port'
export {
  DeviceSessions,
  makeDeviceSessions,
  normalizeRelayUrl,
  type DeviceSessionsService
} from './service'
export { deviceHandlers } from './handlers'
export { DevicesEventsLive } from './events'
export { DevicesLive } from './api'
export { OWNER_ACTOR, deviceActor, deviceIdOfActor } from './actor'
export { DEVICE_FORBIDDEN_MESSAGE, deviceHearsEvent, deviceMayCall } from './scope'
export {
  ANTASPHERE_ISSUER_ENV,
  DEFAULT_ANTASPHERE_ISSUER,
  IdentityTokenRefused,
  JwksCache,
  OwnerMissing,
  resolveAntasphereIssuer,
  verifyIdentityToken
} from './identity-token'
export { DeviceStore, hashToken, type StoredDevice } from './store'
export { PairingDesk, PAIRING_TTL_MS } from './pairings'
export { devicesPushTargets, type PushTarget, type PushTargets } from './push-targets'
