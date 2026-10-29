/** The device records on disk: the hash and never the token, a document
 *  read back whole, a broken one that admits nobody and is never written over. */
import { describe, expect, it } from 'vitest'
import { memoryDeviceStorage } from './port'
import { DeviceStore, DeviceStoreBroken, LAST_SEEN_FLOOR_MS, hashToken } from './store'

const PHONE = { name: 'A phone', platform: 'android' as const, appVersion: '0.1.0' }

describe('the device store', () => {
  it('writes the token’s hash and reads the record back from the document', () => {
    const storage = memoryDeviceStorage()
    const clock = { now: 1_000 }
    const store = new DeviceStore(storage, () => clock.now)
    const { device, token } = store.create(PHONE)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(device.tokenHash).toBe(hashToken(token))
    const text = storage.read()!
    expect(text).toContain(device.tokenHash)
    expect(text).not.toContain(token)
    expect(JSON.parse(text)).toMatchObject({
      v: 1,
      devices: [{ id: device.id, ...PHONE, lastSeenAt: null }]
    })
    const reread = new DeviceStore(storage, () => clock.now)
    expect(reread.authenticate(token)?.id).toBe(device.id)
    expect(reread.authenticate(token.toUpperCase())).toBeNull()
    expect(reread.authenticate('')).toBeNull()
    expect(reread.list()).toEqual([{ id: device.id, ...PHONE, createdAt: 1_000, lastSeenAt: null }])
  })
  it('records a last-seen time at most once a minute', () => {
    const storage = memoryDeviceStorage()
    const clock = { now: 10_000 }
    const store = new DeviceStore(storage, () => clock.now)
    const { device } = store.create(PHONE)
    expect(store.touch(device.id)).toBe(true)
    expect(store.get(device.id)?.lastSeenAt).toBe(10_000)
    clock.now += LAST_SEEN_FLOOR_MS - 1
    expect(store.touch(device.id)).toBe(false)
    clock.now += 1
    expect(store.touch(device.id)).toBe(true)
    expect(store.get(device.id)?.lastSeenAt).toBe(10_000 + LAST_SEEN_FLOOR_MS)
    expect(store.touch('dev-nobody')).toBe(false)
  })
  it('revokes a device for good, and its token with it', () => {
    const storage = memoryDeviceStorage()
    const store = new DeviceStore(storage)
    const { device, token } = store.create(PHONE)
    expect(store.revoke(device.id)).toBe(true)
    expect(store.authenticate(token)).toBeNull()
    expect(store.revoke(device.id)).toBe(false)
    expect(new DeviceStore(storage).authenticate(token)).toBeNull()
  })
  it('admits nobody and writes nothing over a document it cannot read', () => {
    for (const broken of ['not json', '{"v":2,"devices":[]}', '{"v":1,"devices":[{"id":"x"}]}']) {
      const storage = memoryDeviceStorage(broken)
      const store = new DeviceStore(storage)
      expect(store.list(), broken).toEqual([])
      expect(store.authenticate('anything'), broken).toBeNull()
      expect(() => store.create(PHONE), broken).toThrow(DeviceStoreBroken)
      expect(storage.read(), broken).toBe(broken)
    }
    const failing = {
      read: (): string | null => {
        throw new Error('disk')
      },
      write: (): void => {}
    }
    const store = new DeviceStore(failing)
    expect(store.authenticate('anything')).toBeNull()
    expect(() => store.create(PHONE)).toThrow(DeviceStoreBroken)
  })
  it('tells its listeners what changed, and keeps going when one throws', () => {
    const store = new DeviceStore(memoryDeviceStorage())
    const seen: string[] = []
    store.subscribe(() => {
      throw new Error('a bad listener')
    })
    store.subscribe((change) => void seen.push(change.kind))
    const { device } = store.create(PHONE)
    store.setPushToken(device.id, 'fcm-1', 'android')
    store.touch(device.id)
    store.clearPushToken(device.id)
    store.revoke(device.id)
    expect(seen).toEqual(['created', 'push', 'seen', 'push', 'revoked'])
  })
})
