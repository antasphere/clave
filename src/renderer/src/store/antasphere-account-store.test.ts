import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AntasphereAccountStatus } from '../../../shared/antasphere-account-types'

/**
 * The store half of the Antasphere account (PRDCT-3259): what a window
 * shows when main answers, and, the point of this file, when it does not.
 * A bridge call that rejects must be a visible transport failure with the
 * last known status kept, never a silent swallow that leaves the section
 * reading forever; and the exception's words must never reach the store.
 */
const SIGNED_OUT: AntasphereAccountStatus = {
  phase: 'signed-out',
  account: null,
  issuerHost: 'account.antasphere.com',
  signedInAt: null,
  expiresAt: null,
  renewable: false,
  loginStartedAt: null,
  lastFailure: null,
  secureStorage: true
}
const SIGNED_IN: AntasphereAccountStatus = {
  ...SIGNED_OUT,
  phase: 'signed-in',
  account: { subject: 's', name: 'Ada', email: 'ada@example.test', emailVerified: true },
  signedInAt: 1,
  expiresAt: 2,
  renewable: true
}

type Bridge = {
  antasphereAccountGet: () => Promise<AntasphereAccountStatus>
  antasphereAccountSignIn: () => Promise<AntasphereAccountStatus>
  antasphereAccountCancel: () => Promise<AntasphereAccountStatus>
  antasphereAccountSignOut: () => Promise<AntasphereAccountStatus>
  antasphereAccountDismiss: () => Promise<AntasphereAccountStatus>
  onAntasphereAccountChanged: (cb: (status: AntasphereAccountStatus) => void) => () => void
}
const bridge: Bridge & { push: ((status: AntasphereAccountStatus) => void) | null } = {
  push: null,
  antasphereAccountGet: async () => SIGNED_OUT,
  antasphereAccountSignIn: async () => SIGNED_OUT,
  antasphereAccountCancel: async () => SIGNED_OUT,
  antasphereAccountSignOut: async () => SIGNED_OUT,
  antasphereAccountDismiss: async () => SIGNED_OUT,
  onAntasphereAccountChanged: (cb) => {
    bridge.push = cb
    return () => {
      bridge.push = null
    }
  }
}
const reject = async (): Promise<AntasphereAccountStatus> => {
  throw new Error('Error invoking remote method: secret-looking-detail')
}

let store: typeof import('./antasphere-account-store')

beforeAll(async () => {
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = bridge
  store = await import('./antasphere-account-store')
})

beforeEach(() => {
  store.resetAntasphereAccountStore()
  bridge.antasphereAccountGet = async () => SIGNED_OUT
  bridge.antasphereAccountSignIn = async () => SIGNED_OUT
  bridge.antasphereAccountSignOut = async () => SIGNED_OUT
})

describe('loading the account', () => {
  it('takes the status main answers and follows every push', async () => {
    await store.loadAntasphereAccount()
    expect(store.useAntasphereAccountStore.getState()).toMatchObject({
      status: SIGNED_OUT,
      loaded: true,
      transportFailed: false
    })
    bridge.push!(SIGNED_IN)
    expect(store.useAntasphereAccountStore.getState().status).toEqual(SIGNED_IN)
  })

  it('a read that fails is loaded and a transport failure, with nothing of the error kept', async () => {
    bridge.antasphereAccountGet = reject
    await store.loadAntasphereAccount()
    const state = store.useAntasphereAccountStore.getState()
    expect(state).toMatchObject({ status: null, loaded: true, transportFailed: true })
    expect(state.inFlight.get).toBe(false)
    expect(JSON.stringify(state)).not.toContain('secret-looking-detail')
  })

  it('a retry after a failed read clears the failure', async () => {
    bridge.antasphereAccountGet = reject
    await store.loadAntasphereAccount()
    bridge.antasphereAccountGet = async () => SIGNED_IN
    await store.loadAntasphereAccount()
    expect(store.useAntasphereAccountStore.getState()).toMatchObject({
      status: SIGNED_IN,
      transportFailed: false
    })
  })
})

describe('asking main', () => {
  it('a sign-in that does not reach main keeps the last status and says so', async () => {
    await store.loadAntasphereAccount()
    bridge.antasphereAccountSignIn = reject
    await store.useAntasphereAccountStore.getState().signIn()
    expect(store.useAntasphereAccountStore.getState()).toMatchObject({
      status: SIGNED_OUT,
      transportFailed: true
    })
    expect(store.useAntasphereAccountStore.getState().inFlight['sign-in']).toBe(false)
  })

  it('a sign-out that does not reach main keeps the login on screen, honestly', async () => {
    bridge.antasphereAccountGet = async () => SIGNED_IN
    await store.loadAntasphereAccount()
    bridge.antasphereAccountSignOut = reject
    await store.useAntasphereAccountStore.getState().signOut()
    const state = store.useAntasphereAccountStore.getState()
    expect(state.status?.phase).toBe('signed-in')
    expect(state.transportFailed).toBe(true)
  })

  it('the next ask that lands clears the transport failure', async () => {
    await store.loadAntasphereAccount()
    bridge.antasphereAccountSignIn = reject
    await store.useAntasphereAccountStore.getState().signIn()
    bridge.antasphereAccountSignIn = async () => ({ ...SIGNED_OUT, phase: 'signing-in' })
    await store.useAntasphereAccountStore.getState().signIn()
    expect(store.useAntasphereAccountStore.getState()).toMatchObject({
      transportFailed: false,
      status: { phase: 'signing-in' }
    })
  })

  it('a missing bridge is a transport failure too', async () => {
    const api = (globalThis as unknown as { electronAPI: unknown }).electronAPI
    ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = undefined
    try {
      await store.loadAntasphereAccount()
      expect(store.useAntasphereAccountStore.getState()).toMatchObject({
        loaded: true,
        transportFailed: true
      })
    } finally {
      ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = api
    }
  })
})

describe('a sign-in that answers late', () => {
  const SIGNING_IN: AntasphereAccountStatus = {
    ...SIGNED_OUT,
    phase: 'signing-in',
    loginStartedAt: 1
  }
  const CANCELLED: AntasphereAccountStatus = { ...SIGNED_OUT, lastFailure: 'cancelled' }
  /** A sign-in whose answer the test releases by hand. */
  const held = (): { release: () => void } => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    bridge.antasphereAccountSignIn = async () => {
      await gate
      return SIGNING_IN
    }
    return { release }
  }

  it('leaves Cancel usable while the sign-in waits, and the cancel is sent', async () => {
    await store.loadAntasphereAccount()
    const { release } = held()
    let cancels = 0
    bridge.antasphereAccountCancel = async () => {
      cancels++
      return CANCELLED
    }
    const signingIn = store.useAntasphereAccountStore.getState().signIn()
    expect(store.useAntasphereAccountStore.getState().inFlight).toMatchObject({
      'sign-in': true,
      cancel: false
    })
    await store.useAntasphereAccountStore.getState().cancel()
    expect(cancels).toBe(1)
    expect(store.useAntasphereAccountStore.getState().status).toEqual(CANCELLED)
    release()
    await signingIn
    // The late answer is dropped: the cancel stands.
    expect(store.useAntasphereAccountStore.getState().status).toEqual(CANCELLED)
    expect(store.useAntasphereAccountStore.getState().inFlight['sign-in']).toBe(false)
  })

  it('cannot overwrite a sign-out or a push that came after it', async () => {
    await store.loadAntasphereAccount()
    const { release } = held()
    const signingIn = store.useAntasphereAccountStore.getState().signIn()
    bridge.push!(SIGNED_IN)
    expect(store.useAntasphereAccountStore.getState().status).toEqual(SIGNED_IN)
    release()
    await signingIn
    expect(store.useAntasphereAccountStore.getState().status).toEqual(SIGNED_IN)

    const second = held()
    const again = store.useAntasphereAccountStore.getState().signIn()
    await store.useAntasphereAccountStore.getState().signOut()
    expect(store.useAntasphereAccountStore.getState().status).toEqual(SIGNED_OUT)
    second.release()
    await again
    expect(store.useAntasphereAccountStore.getState().status).toEqual(SIGNED_OUT)
  })

  it('a late failure of the stale ask is not shown over the newer state either', async () => {
    await store.loadAntasphereAccount()
    let fail!: () => void
    bridge.antasphereAccountSignIn = () =>
      new Promise((_resolve, reject) => {
        fail = () => reject(new Error('late'))
      })
    const signingIn = store.useAntasphereAccountStore.getState().signIn()
    bridge.antasphereAccountCancel = async () => CANCELLED
    await store.useAntasphereAccountStore.getState().cancel()
    fail()
    await signingIn
    expect(store.useAntasphereAccountStore.getState()).toMatchObject({
      status: CANCELLED,
      transportFailed: false
    })
  })

  it('a second sign-in while one is on its way is not sent', async () => {
    await store.loadAntasphereAccount()
    let sent = 0
    const { release } = held()
    const first = bridge.antasphereAccountSignIn
    bridge.antasphereAccountSignIn = () => {
      sent++
      return first()
    }
    const a = store.useAntasphereAccountStore.getState().signIn()
    const b = store.useAntasphereAccountStore.getState().signIn()
    release()
    await Promise.all([a, b])
    expect(sent).toBe(1)
    expect(store.useAntasphereAccountStore.getState().status).toEqual(SIGNING_IN)
  })
})

describe('the words for a failure', () => {
  it('name no issuer, token, scope or server text', () => {
    for (const code of [
      'cancelled',
      'timeout',
      'denied',
      'network',
      'invalid-response',
      'registration',
      'storage',
      'configuration',
      'expired'
    ] as const) {
      const text = store.describeAntasphereFailure(code)
      expect(text.length).toBeGreaterThan(10)
      expect(text).not.toMatch(/token|scope|OIDC|OAuth|issuer|http/i)
    }
  })
})
