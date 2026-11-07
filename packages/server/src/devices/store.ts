/**
 * The device records: one document through the storage port (`devices.json`,
 * mode 0600 at the adapter, like `server-connections.json`), replaced whole
 * on every change. A record keeps the device's id, name, platform, app
 * version, when it was created and last seen, the SHA-256 of its session
 * token (never the token) and its push token with its platform. The token
 * itself exists for the length of the pairing answer that carries it.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DeviceDescription, DevicePlatform, DeviceView } from '@clave/contract/devices'
import type { DeviceDocumentStorage } from './port'
import type { PushTarget } from './push-targets'

export interface StoredDevice {
  readonly id: string
  readonly name: string
  readonly platform: DevicePlatform
  readonly appVersion: string
  readonly createdAt: number
  readonly lastSeenAt: number | null
  /** The SHA-256 of the session token, in hex. */
  readonly tokenHash: string
  readonly push: { readonly token: string; readonly platform: DevicePlatform } | null
}

export type DeviceChange =
  | { kind: 'created'; deviceId: string }
  | { kind: 'revoked'; deviceId: string }
  | { kind: 'seen'; deviceId: string }
  | { kind: 'push'; deviceId: string }

/** A last-seen time is written at most this often per device. */
export const LAST_SEEN_FLOOR_MS = 60_000
const TOKEN_BYTES = 32
const MAX_DEVICES = 64

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

const view = (device: StoredDevice): DeviceView => ({
  id: device.id,
  name: device.name,
  platform: device.platform,
  appVersion: device.appVersion,
  createdAt: device.createdAt,
  lastSeenAt: device.lastSeenAt
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const platform = (value: unknown): value is DevicePlatform => value === 'ios' || value === 'android'

/** A document that could not be read admits nobody and is never written over. */
export class DeviceStoreBroken extends Error {
  constructor() {
    super('The device records could not be read; the document was left unchanged.')
    this.name = 'DeviceStoreBroken'
  }
}

export class DeviceStore {
  private devices: StoredDevice[] | null = null
  private byHash = new Map<string, StoredDevice>()
  private broken = false
  private readonly listeners = new Set<(change: DeviceChange) => void>()

  constructor(
    private readonly storage: DeviceDocumentStorage,
    private readonly now: () => number = Date.now
  ) {}

  list(): DeviceView[] {
    return this.load().map(view)
  }

  get(id: string): StoredDevice | undefined {
    return this.load().find((device) => device.id === id)
  }

  /** The device a presented token belongs to, by the hash of the token. */
  authenticate(presented: string): StoredDevice | null {
    this.load()
    if (this.broken || presented.length === 0) return null
    return this.byHash.get(hashToken(presented)) ?? null
  }

  /** A new device and its session token, the one time the token exists in clear. */
  create(description: DeviceDescription): { device: StoredDevice; token: string } {
    const devices = this.load()
    if (devices.length >= MAX_DEVICES) throw new Error('Too many paired phones.')
    const token = randomBytes(TOKEN_BYTES).toString('hex')
    const device: StoredDevice = {
      id: `dev-${randomUUID()}`,
      name: description.name,
      platform: description.platform,
      appVersion: description.appVersion,
      createdAt: this.now(),
      lastSeenAt: null,
      tokenHash: hashToken(token),
      push: null
    }
    this.persist([...devices, device])
    this.tell({ kind: 'created', deviceId: device.id })
    return { device, token }
  }

  revoke(id: string): boolean {
    const devices = this.load()
    if (!devices.some((device) => device.id === id)) return false
    this.persist(devices.filter((device) => device.id !== id))
    this.tell({ kind: 'revoked', deviceId: id })
    return true
  }

  /** Record a call from the device; written at most once a minute. Answers whether it wrote. */
  touch(id: string): boolean {
    const device = this.get(id)
    if (!device) return false
    const now = this.now()
    if (device.lastSeenAt !== null && now - device.lastSeenAt < LAST_SEEN_FLOOR_MS) return false
    this.replace({ ...device, lastSeenAt: now })
    this.tell({ kind: 'seen', deviceId: id })
    return true
  }

  setPushToken(id: string, token: string, pushPlatform: DevicePlatform): boolean {
    const device = this.get(id)
    if (!device) return false
    this.replace({ ...device, push: { token, platform: pushPlatform } })
    this.tell({ kind: 'push', deviceId: id })
    return true
  }

  /** Clear the push token; with `token` given, only when it is still that one. */
  clearPushToken(id: string, token?: string): boolean {
    const device = this.get(id)
    if (!device || device.push === null) return false
    if (token !== undefined && device.push.token !== token) return false
    this.replace({ ...device, push: null })
    this.tell({ kind: 'push', deviceId: id })
    return true
  }

  /** Lane B's seam: every device with a push token. */
  pushTargets(): PushTarget[] {
    return this.load()
      .filter((device) => device.push !== null)
      .map((device) => ({
        deviceId: device.id,
        platform: device.push!.platform,
        token: device.push!.token
      }))
  }

  subscribe(listener: (change: DeviceChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private tell(change: DeviceChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch (error) {
        console.error('[clave-server] device listener failed', error)
      }
    }
  }

  private replace(next: StoredDevice): void {
    this.persist(this.load().map((device) => (device.id === next.id ? next : device)))
  }

  private persist(devices: StoredDevice[]): void {
    if (this.broken) throw new DeviceStoreBroken()
    this.storage.write(
      JSON.stringify(
        {
          v: 1,
          devices: devices.map((device) => ({
            id: device.id,
            name: device.name,
            platform: device.platform,
            appVersion: device.appVersion,
            createdAt: device.createdAt,
            lastSeenAt: device.lastSeenAt,
            tokenHash: device.tokenHash,
            push: device.push
          }))
        },
        null,
        2
      )
    )
    this.index(devices)
  }

  private index(devices: StoredDevice[]): void {
    this.devices = devices
    this.byHash = new Map(devices.map((device) => [device.tokenHash, device]))
  }

  private load(): StoredDevice[] {
    if (this.devices) return this.devices
    if (this.broken) return []
    let source: string | null
    try {
      source = this.storage.read()
    } catch {
      this.broken = true
      return []
    }
    if (source === null) {
      this.index([])
      return this.devices!
    }
    try {
      const data: unknown = JSON.parse(source)
      if (!isRecord(data) || data.v !== 1 || !Array.isArray(data.devices)) throw new Error('shape')
      const ids = new Set<string>()
      const devices = data.devices.map((value: unknown): StoredDevice => {
        if (
          !isRecord(value) ||
          !text(value.id, 128) ||
          ids.has(value.id) ||
          !text(value.name, 120) ||
          !platform(value.platform) ||
          !text(value.appVersion, 64) ||
          typeof value.createdAt !== 'number' ||
          !(value.lastSeenAt === null || typeof value.lastSeenAt === 'number') ||
          !text(value.tokenHash, 64) ||
          !(
            value.push === null ||
            (isRecord(value.push) && text(value.push.token, 4096) && platform(value.push.platform))
          )
        )
          throw new Error('record')
        ids.add(value.id)
        const push = value.push as { token: string; platform: DevicePlatform } | null
        return {
          id: value.id,
          name: value.name,
          platform: value.platform,
          appVersion: value.appVersion,
          createdAt: value.createdAt,
          lastSeenAt: value.lastSeenAt,
          tokenHash: value.tokenHash,
          push: push === null ? null : { token: push.token, platform: push.platform }
        }
      })
      this.index(devices)
      return devices
    } catch {
      this.broken = true
      return []
    }
  }
}
