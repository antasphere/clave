import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceView, DevicesView, PendingPairingView } from '../../../shared/mobile-types'

/**
 * The store half of Settings → Mobile (mobile wave, lane A): what the page
 * holds when the server answers, when its answers land out of order, and
 * when a call does not land. `window` is this global and the bridge a set of
 * fakes, the way the Antasphere account's store is tested.
 */
const PHONE: DeviceView = {
  id: 'dev-1',
  name: 'Ada’s iPhone',
  platform: 'ios',
  appVersion: '1.0.0',
  createdAt: 1_700_000_000_000,
  lastSeenAt: null
}
const ASKING: PendingPairingView = {
  id: 'pair-1',
  name: 'Pixel 9',
  platform: 'android',
  appVersion: '1.0.0',
  requestedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_600_000
}
const VIEW: DevicesView = { revision: 3, devices: [PHONE], pending: [ASKING] }
const RELAY = 'https://relay.example.com'
const NOT_UP = "Clave's server is not up yet; try again in a moment."

const bridge = {
  devicesList: vi.fn<() => Promise<DevicesView>>(),
  devicesApprove: vi.fn<(pairingId: string) => Promise<DeviceView>>(),
  devicesRefuse: vi.fn<(pairingId: string) => Promise<void>>(),
  devicesRevoke: vi.fn<(deviceId: string) => Promise<void>>(),
  mobileRelayGet: vi.fn<() => Promise<string>>(),
  mobileRelaySet: vi.fn<(url: string) => Promise<string>>(),
  onDevicesChanged: vi.fn<(callback: (revision: number) => void) => () => void>()
}
/** The change signal the store subscribed with, fired by hand. */
let signal: ((revision: number) => void) | null = null

let store: typeof import('./mobile-store')
const state = (): ReturnType<typeof store.useMobileStore.getState> =>
  store.useMobileStore.getState()
/** Lets the work a signal starts, which nobody awaits, run to its end. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
/** An answer the test releases by hand. */
const held = <T>(value: T): { answer: () => Promise<T>; release: () => void } => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    answer: async () => {
      await gate
      return value
    },
    release
  }
}

beforeAll(async () => {
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = bridge
  store = await import('./mobile-store')
})

beforeEach(() => {
  store.resetMobileStore()
  for (const fn of Object.values(bridge)) fn.mockReset()
  bridge.devicesList.mockResolvedValue(VIEW)
  bridge.devicesApprove.mockResolvedValue(PHONE)
  bridge.devicesRefuse.mockResolvedValue(undefined)
  bridge.devicesRevoke.mockResolvedValue(undefined)
  bridge.mobileRelayGet.mockResolvedValue(RELAY)
  bridge.mobileRelaySet.mockImplementation(async (url) => url.trim())
  signal = null
  bridge.onDevicesChanged.mockImplementation((callback) => {
    signal = callback
    return () => {
      signal = null
    }
  })
})

describe('loading the page', () => {
  it('lists, reads the relay address and subscribes once per window', async () => {
    await store.loadMobile()
    expect(bridge.devicesList).toHaveBeenCalledTimes(1)
    expect(bridge.mobileRelayGet).toHaveBeenCalledTimes(1)
    expect(bridge.onDevicesChanged).toHaveBeenCalledTimes(1)
    expect(state()).toMatchObject({
      revision: 3,
      devices: [PHONE],
      pending: [ASKING],
      relayUrl: RELAY,
      loaded: true,
      transportFailed: false,
      failureText: null
    })
    expect(state().inFlight).toMatchObject({ list: false, relay: false })

    await store.loadMobile()
    expect(bridge.onDevicesChanged).toHaveBeenCalledTimes(1)
    expect(bridge.devicesList).toHaveBeenCalledTimes(2)
    expect(bridge.mobileRelayGet).toHaveBeenCalledTimes(2)
  })

  it('reads the page again at every change signal', async () => {
    await store.loadMobile()
    bridge.devicesList.mockResolvedValue({ revision: 4, devices: [PHONE], pending: [] })
    bridge.mobileRelayGet.mockResolvedValue('https://relay.example.org')
    signal!(4)
    await settle()
    expect(bridge.devicesList).toHaveBeenCalledTimes(2)
    expect(state()).toMatchObject({
      revision: 4,
      pending: [],
      relayUrl: 'https://relay.example.org'
    })
  })
})

describe('answers that land out of order', () => {
  it('ignores a list whose revision is behind the last one applied', async () => {
    bridge.devicesList.mockResolvedValue({ ...VIEW, revision: 5 })
    await store.loadMobile()
    bridge.devicesList.mockResolvedValue({ revision: 4, devices: [], pending: [] })
    signal!(4)
    await settle()
    expect(bridge.devicesList).toHaveBeenCalledTimes(2)
    expect(state()).toMatchObject({ revision: 5, devices: [PHONE], pending: [ASKING] })
  })

  it('keeps the newer list when an older one lands after it', async () => {
    await store.loadMobile()
    const older = held<DevicesView>({ ...VIEW, revision: 6 })
    bridge.devicesList.mockImplementationOnce(older.answer)
    bridge.devicesList.mockResolvedValueOnce({ revision: 7, devices: [PHONE], pending: [] })
    signal!(6)
    signal!(7)
    await settle()
    expect(state()).toMatchObject({ revision: 7, pending: [] })
    expect(state().inFlight.list).toBe(true)
    older.release()
    await settle()
    expect(state()).toMatchObject({ revision: 7, pending: [] })
    expect(state().inFlight.list).toBe(false)
  })

  it('a relay read sent before a save cannot put the old address back', async () => {
    await store.loadMobile()
    const read = held('https://old.example.com')
    bridge.mobileRelayGet.mockImplementationOnce(read.answer)
    signal!(4)
    await state().saveRelay('https://new.example.com')
    read.release()
    await settle()
    expect(state().relayUrl).toBe('https://new.example.com')
  })
})

describe('asking the server', () => {
  it('approves the phone by its id, then lists again', async () => {
    await store.loadMobile()
    const added: DeviceView = { ...PHONE, id: 'dev-2', name: 'Pixel 9', platform: 'android' }
    bridge.devicesList.mockResolvedValue({ revision: 4, devices: [PHONE, added], pending: [] })
    const approving = state().approve('pair-1')
    expect(state().inFlight['approve:pair-1']).toBe(true)
    await approving
    expect(bridge.devicesApprove).toHaveBeenCalledWith('pair-1')
    expect(bridge.devicesList).toHaveBeenCalledTimes(2)
    expect(bridge.devicesApprove.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.devicesList.mock.invocationCallOrder[1]
    )
    expect(state()).toMatchObject({ revision: 4, devices: [PHONE, added], pending: [] })
    expect(state().inFlight['approve:pair-1']).toBe(false)
  })

  it('refuses and revokes the same way, each by its own id', async () => {
    await store.loadMobile()
    await state().refuse('pair-1')
    await state().revoke('dev-1')
    expect(bridge.devicesRefuse).toHaveBeenCalledWith('pair-1')
    expect(bridge.devicesRevoke).toHaveBeenCalledWith('dev-1')
    expect(bridge.devicesList).toHaveBeenCalledTimes(3)
  })

  it('a second approval of the same phone while the first is out is not sent', async () => {
    await store.loadMobile()
    const answer = held(PHONE)
    bridge.devicesApprove.mockImplementationOnce(answer.answer)
    const first = state().approve('pair-1')
    const second = state().approve('pair-1')
    expect(state().inFlight['approve:pair-1']).toBe(true)
    expect(state().inFlight['refuse:pair-1']).toBeFalsy()
    answer.release()
    await Promise.all([first, second])
    expect(bridge.devicesApprove).toHaveBeenCalledTimes(1)
  })
})

describe('a call that does not land', () => {
  it('is a transport failure with the sentence it carries, never its stack', async () => {
    await store.loadMobile()
    const error = new Error(NOT_UP)
    error.stack = `Error: ${NOT_UP}\n    at secret-looking-frame (preload.js:1:1)`
    bridge.devicesRevoke.mockRejectedValueOnce(error)
    await state().revoke('dev-1')
    expect(state()).toMatchObject({
      transportFailed: true,
      failureText: NOT_UP,
      devices: [PHONE]
    })
    expect(state().inFlight['revoke:dev-1']).toBe(false)
    expect(JSON.stringify(state())).not.toContain('secret-looking-frame')
  })

  it('a list that fails at load is shown, and a retry that lands clears it', async () => {
    bridge.devicesList.mockRejectedValueOnce(new Error(NOT_UP))
    await store.loadMobile()
    expect(state()).toMatchObject({ loaded: true, transportFailed: true, failureText: NOT_UP })
    await store.loadMobile()
    expect(state()).toMatchObject({ revision: 3, transportFailed: false, failureText: null })
  })

  it('the next change signal lifts a failed read, never a failed ask', async () => {
    bridge.devicesList.mockRejectedValueOnce(new Error(NOT_UP))
    await store.loadMobile()
    signal!(0)
    await settle()
    expect(state()).toMatchObject({ revision: 3, transportFailed: false, failureText: null })

    bridge.devicesApprove.mockRejectedValueOnce(new Error('The phone stopped waiting.'))
    await state().approve('pair-1')
    signal!(5)
    await settle()
    expect(state()).toMatchObject({
      transportFailed: true,
      failureText: 'The phone stopped waiting.'
    })
  })

  it('a missing bridge is a failure with no sentence of its own', async () => {
    const api = (globalThis as unknown as { electronAPI: unknown }).electronAPI
    ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = undefined
    try {
      await store.loadMobile()
      expect(state()).toMatchObject({ loaded: true, transportFailed: true, failureText: null })
    } finally {
      ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = api
    }
  })
})

describe('the relay address', () => {
  it('a refusal stays on the relay card and moves nothing else', async () => {
    await store.loadMobile()
    const refusal = 'The relay address must be an http or https origin.'
    bridge.mobileRelaySet.mockRejectedValueOnce(new Error(refusal))
    await state().saveRelay('ftp://relay.example.com')
    expect(bridge.mobileRelaySet).toHaveBeenCalledWith('ftp://relay.example.com')
    expect(state()).toMatchObject({
      relayError: refusal,
      relayUrl: RELAY,
      transportFailed: false,
      failureText: null
    })
    expect(state().inFlight.relay).toBe(false)
    expect(bridge.devicesList).toHaveBeenCalledTimes(1)
  })

  it('a save keeps the address the server stored, clears the refusal and lists again', async () => {
    await store.loadMobile()
    bridge.mobileRelaySet.mockRejectedValueOnce(new Error('Refused.'))
    await state().saveRelay('nope')
    bridge.mobileRelaySet.mockResolvedValueOnce('https://relay.example.org')
    await state().saveRelay(' https://Relay.Example.org/ ')
    expect(bridge.mobileRelaySet).toHaveBeenLastCalledWith(' https://Relay.Example.org/ ')
    expect(state()).toMatchObject({ relayUrl: 'https://relay.example.org', relayError: null })
    expect(bridge.devicesList).toHaveBeenCalledTimes(2)
  })
})
