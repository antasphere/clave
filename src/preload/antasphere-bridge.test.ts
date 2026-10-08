import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from './index.d'

/**
 * The Antasphere account at the bridge (PRDCT-3259): what the page gets is
 * the status and only the status. A sign-in's answer carries the browser
 * handoff (the authorization URL, bound to the login's generation) to THIS
 * preload, which hands it to main to open and hands the page the status
 * without it. Main names no server here, so every call goes over IPC; the
 * server arm takes the same shape (`packages/client/src/settings.ts`).
 */
const mocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => mocks.exposed.set(key, value)
  },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener },
  webUtils: {}
}))
import './index'
const api = mocks.exposed.get('electronAPI') as ElectronAPI
const ipcCalls = (): unknown[][] =>
  mocks.invoke.mock.calls.filter(([channel]) => channel !== 'server:endpoint')

const status = {
  phase: 'signing-in',
  account: null,
  issuerHost: 'issuer.test',
  signedInAt: null,
  expiresAt: null,
  renewable: false,
  loginStartedAt: 1,
  lastFailure: null,
  secureStorage: true
}
const handoff = { url: 'https://issuer.test/authorize?state=s1', generation: 4 }

/** Main as it answers by default: the sign-in with its handoff, the
 *  confirmation true, the open accepted. Each test narrows one answer. */
const answers = (
  overrides: Partial<Record<string, (...args: unknown[]) => Promise<unknown>>> = {}
): void => {
  mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const override = overrides[channel]
    if (override) return override(...args)
    if (channel === 'server:endpoint') return null
    if (channel === 'antasphere-account:sign-in') return { status, handoff }
    if (channel === 'antasphere-account:confirm-handoff') return true
    if (channel === 'antasphere-account:open-browser') return undefined
    return status
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  answers()
})

describe('the Antasphere account bridge', () => {
  it('a sign-in confirms the handoff with its manager, hands it to main, and the page the status alone', async () => {
    const answered = await api.antasphereAccountSignIn()
    expect(answered).toEqual(status)
    expect(JSON.stringify(answered)).not.toContain('authorize')
    expect(ipcCalls()).toEqual([
      ['antasphere-account:sign-in'],
      ['antasphere-account:confirm-handoff', handoff],
      ['antasphere-account:open-browser', handoff]
    ])
  })

  it('a handoff the manager no longer confirms opens nothing: the login moved on where this preload could not hear it', async () => {
    // The manager's own answer is the last word on what it issued: no
    // cancel here, no status heard, and still the login is not the one the
    // handoff names (another client ended it with the event not yet in).
    answers({ 'antasphere-account:confirm-handoff': async () => false })
    expect(await api.antasphereAccountSignIn()).toEqual(status)
    expect(ipcCalls().map(([channel]) => channel)).toEqual([
      'antasphere-account:sign-in',
      'antasphere-account:confirm-handoff'
    ])
  })

  it('a sign-in whose answer lands after a cancel asks for no confirmation at all', async () => {
    let releaseSignIn!: () => void
    const held = new Promise<void>((resolve) => {
      releaseSignIn = resolve
    })
    answers({
      'antasphere-account:sign-in': async () => {
        await held
        return { status, handoff }
      },
      'antasphere-account:cancel': async () => ({
        ...status,
        phase: 'signed-out',
        lastFailure: 'cancelled'
      })
    })
    const signingIn = api.antasphereAccountSignIn()
    expect(await api.antasphereAccountCancel()).toMatchObject({ lastFailure: 'cancelled' })
    releaseSignIn()
    // The status it was given, for the page's store to drop as stale.
    expect(await signingIn).toEqual(status)
    expect(ipcCalls().map(([channel]) => channel)).toEqual([
      'antasphere-account:sign-in',
      'antasphere-account:cancel'
    ])
  })

  it('a confirmation that cannot be had opens nothing: the browser never opens on a guess', async () => {
    answers({
      'antasphere-account:confirm-handoff': async () => {
        throw new Error('no server')
      }
    })
    expect(await api.antasphereAccountSignIn()).toEqual(status)
    expect(ipcCalls().map(([channel]) => channel)).not.toContain('antasphere-account:open-browser')
    // Nor on an answer that is not exactly `true`.
    vi.clearAllMocks()
    answers({ 'antasphere-account:confirm-handoff': async () => 'yes' })
    await api.antasphereAccountSignIn()
    expect(ipcCalls().map(([channel]) => channel)).not.toContain('antasphere-account:open-browser')
  })

  it('a sign-in that answers no handoff confirms and opens nothing', async () => {
    answers({
      'antasphere-account:sign-in': async () => ({
        status: { ...status, phase: 'signed-out', lastFailure: 'network' },
        handoff: null
      })
    })
    const answered = await api.antasphereAccountSignIn()
    expect(answered).toMatchObject({ phase: 'signed-out', lastFailure: 'network' })
    expect(ipcCalls()).toEqual([['antasphere-account:sign-in']])
  })

  it('a browser main could not open does not fail the sign-in: the status still answers', async () => {
    answers({
      'antasphere-account:open-browser': async () => {
        throw new Error('refused')
      }
    })
    expect(await api.antasphereAccountSignIn()).toEqual(status)
  })

  it('the other four calls answer the status over their own channels', async () => {
    expect(await api.antasphereAccountGet()).toEqual(status)
    expect(await api.antasphereAccountCancel()).toEqual(status)
    expect(await api.antasphereAccountSignOut()).toEqual(status)
    expect(await api.antasphereAccountDismiss()).toEqual(status)
    expect(ipcCalls().map(([channel]) => channel)).toEqual([
      'antasphere-account:get',
      'antasphere-account:cancel',
      'antasphere-account:sign-out',
      'antasphere-account:dismiss'
    ])
  })
})

describe('the handoff guard of this preload: a confirmation that answers late', () => {
  /** A confirmation whose reply the test releases by hand, with `true`. */
  const heldConfirmation = (): { release: () => void } => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    answers({
      'antasphere-account:confirm-handoff': async () => {
        await gate
        return true
      }
    })
    return { release }
  }
  const opened = (): number =>
    ipcCalls().filter(([channel]) => channel === 'antasphere-account:open-browser').length
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('a cancel that finishes before an older `true` lands leaves the page unopened', async () => {
    const { release } = heldConfirmation()
    const signingIn = api.antasphereAccountSignIn()
    await tick()
    expect(await api.antasphereAccountCancel()).toEqual(status)
    release()
    expect(await signingIn).toEqual(status)
    expect(opened()).toBe(0)
    expect(ipcCalls().map(([c]) => c)).toEqual([
      'antasphere-account:sign-in',
      'antasphere-account:confirm-handoff',
      'antasphere-account:cancel'
    ])
  })

  it('and so does a sign-out', async () => {
    const { release } = heldConfirmation()
    const signingIn = api.antasphereAccountSignIn()
    await tick()
    await api.antasphereAccountSignOut()
    release()
    await signingIn
    expect(opened()).toBe(0)
  })

  it('a newer sign-in opens its own page; the older confirmation opens none', async () => {
    const { release } = heldConfirmation()
    const first = api.antasphereAccountSignIn()
    await tick()
    answers()
    await api.antasphereAccountSignIn()
    expect(opened()).toBe(1)
    release()
    await first
    expect(opened()).toBe(1)
  })

  it('a status from the server saying the login is over invalidates it; its own signing-in push does not', async () => {
    const { release } = heldConfirmation()
    const heard: unknown[] = []
    api.onAntasphereAccountChanged((s) => heard.push(s))
    const deliver = (s: unknown): void => {
      for (const [channel, listener] of mocks.on.mock.calls as [
        string,
        (...a: unknown[]) => void
      ][])
        if (channel === 'antasphere-account:changed') listener({}, s)
    }
    const signingIn = api.antasphereAccountSignIn()
    await tick()
    // The start's own push: the flow being opened, not a reason to drop it.
    deliver(status)
    // Another window cancelled: the login is no longer in flight.
    deliver({ ...status, phase: 'signed-out', lastFailure: 'cancelled' })
    release()
    await signingIn
    expect(opened()).toBe(0)
    expect(heard).toHaveLength(2)

    // The same with only the signing-in push: the page opens.
    vi.clearAllMocks()
    const second = heldConfirmation()
    const again = api.antasphereAccountSignIn()
    await tick()
    deliver(status)
    second.release()
    await again
    expect(opened()).toBe(1)
  })
})

describe('the same guard on the server arm', () => {
  it('a `true` the server computed before a cancel, delivered after it, opens nothing', async () => {
    const { startEmbedded } = await import('@clave/server')
    const { FakeSettingsSource } = await import('@clave/server/settings/test-support')
    const { FakeSource } = await import('@clave/server/test-support')
    const fake = new FakeSettingsSource()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // The server's answer is computed at once (the login is in flight) and
    // held on its way out.
    const confirm = fake.antasphere.confirmHandoff
    Object.assign(fake.antasphere, {
      confirmHandoff: async (handoff: { url: string; generation: number }) => {
        const computed = await confirm(handoff)
        await gate
        return computed
      }
    })
    const server = await startEmbedded({ ports: { sessions: new FakeSource(), settings: fake } })
    try {
      mocks.invoke.mockImplementation(async (channel: string) => {
        if (channel === 'server:endpoint') return { url: server.url, token: server.token }
        return undefined
      })
      const signingIn = api.antasphereAccountSignIn()
      // The sign-in and the confirmation reached the server (the client
      // loads on this first routed call, seconds under load); then the
      // cancel lands while the confirmation's `true` is held.
      const deadline = Date.now() + 15_000
      while (!fake.calls.some((c) => c.method === 'antasphere.confirmHandoff')) {
        if (Date.now() > deadline) throw new Error('the confirmation never reached the server')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(fake.calls.map((c) => c.method)).toEqual([
        'antasphere.signIn',
        'antasphere.confirmHandoff'
      ])
      expect(await api.antasphereAccountCancel()).toMatchObject({ lastFailure: 'cancelled' })
      release()
      expect(await signingIn).toMatchObject({ phase: 'signing-in' })
      expect(mocks.invoke.mock.calls.map(([c]) => c)).not.toContain(
        'antasphere-account:open-browser'
      )
      // Without the cancel in between, the same server arm opens the page.
      mocks.invoke.mockClear()
      await api.antasphereAccountSignIn()
      expect(mocks.invoke.mock.calls.map(([c]) => c)).toContain('antasphere-account:open-browser')
    } finally {
      await server.stop()
    }
  }, 20_000)
})
