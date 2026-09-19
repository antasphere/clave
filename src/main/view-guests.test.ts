import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The wiring, not the rule.
 *
 * The rule has its own tests; what they cannot show is whether it is actually
 * installed on the session the guest pages run in, and whether the two
 * handlers Chromium consults route to it. An independent verifier replaced the
 * request handler with `callback(true)` — granting every permission to every
 * page, the Electron default this module exists to prevent — and the whole
 * suite stayed green. These tests are that mutation's answer.
 *
 * Electron is faked down to the two calls under test: the handlers are
 * captured as they are installed, then invoked the way Chromium invokes them.
 */

const handlers: {
  request?: (
    contents: unknown,
    permission: string,
    callback: (ok: boolean) => void,
    details: unknown
  ) => void
  check?: (contents: unknown, permission: string, origin: string, details: unknown) => boolean
} = {}

const fromPartition = vi.fn(() => ({
  setPermissionRequestHandler: (fn: typeof handlers.request) => {
    handlers.request = fn
  },
  setPermissionCheckHandler: (fn: typeof handlers.check) => {
    handlers.check = fn
  }
}))

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  session: { fromPartition: (...args: unknown[]) => fromPartition(...(args as [])) },
  shell: { openExternal: vi.fn(() => Promise.resolve()) }
}))

const { installViewGuestPolicy, VIEW_PARTITION } = await import('./view-guests')

/** Invoke the request handler the way Chromium does, and read the answer. */
function request(permission: string, details: Record<string, unknown>): boolean {
  let answer: boolean | undefined
  handlers.request?.(
    {},
    permission,
    (ok) => {
      answer = ok
    },
    details
  )
  return answer ?? false
}

/** Invoke the check handler the way Chromium does. */
function check(permission: string, origin: string, details: Record<string, unknown>): boolean {
  return handlers.check?.({}, permission, origin, details) ?? false
}

const LOCAL = 'http://127.0.0.1:4796/'
const WEB = 'https://example.com/'

describe('installViewGuestPolicy', () => {
  beforeEach(() => {
    handlers.request = undefined
    handlers.check = undefined
    installViewGuestPolicy()
  })

  it('installs both handlers on the guest partition', () => {
    // Neither installed means Electron's default answers every request with
    // yes, which is the worst outcome and shows nowhere in the app.
    expect(fromPartition).toHaveBeenCalledWith(VIEW_PARTITION)
    expect(typeof handlers.request).toBe('function')
    expect(typeof handlers.check).toBe('function')
  })

  it('grants the microphone to the local page Clave shows, through both handlers', () => {
    expect(
      request('media', { securityOrigin: LOCAL, mediaTypes: ['audio'], isMainFrame: true })
    ).toBe(true)
    expect(check('media', LOCAL, { mediaType: 'audio', isMainFrame: true })).toBe(true)
  })

  it('refuses the internet, through both handlers', () => {
    expect(
      request('media', { securityOrigin: WEB, mediaTypes: ['audio'], isMainFrame: true })
    ).toBe(false)
    expect(check('media', WEB, { mediaType: 'audio', isMainFrame: true })).toBe(false)
  })

  it('refuses a subframe, through both handlers', () => {
    expect(
      request('media', { securityOrigin: LOCAL, mediaTypes: ['audio'], isMainFrame: false })
    ).toBe(false)
    expect(check('media', LOCAL, { mediaType: 'audio', isMainFrame: false })).toBe(false)
  })

  it('refuses the camera on a local page, through both handlers', () => {
    expect(
      request('media', { securityOrigin: LOCAL, mediaTypes: ['video'], isMainFrame: true })
    ).toBe(false)
    expect(check('media', LOCAL, { mediaType: 'video', isMainFrame: true })).toBe(false)
  })

  it('refuses every other permission on a local page, through both handlers', () => {
    for (const permission of [
      'geolocation',
      'notifications',
      'clipboard-read',
      'display-capture'
    ]) {
      expect(request(permission, { securityOrigin: LOCAL, isMainFrame: true })).toBe(false)
      expect(check(permission, LOCAL, { isMainFrame: true })).toBe(false)
    }
  })

  it('refuses a request whose origin is missing', () => {
    // Chromium really does pass an empty requesting origin on the first checks
    // of a page load. Absent must fail closed, never fall back to something
    // that happens to look local.
    expect(request('media', { mediaTypes: ['audio'], isMainFrame: true })).toBe(false)
    expect(check('media', '', { mediaType: 'audio', isMainFrame: true })).toBe(false)
  })

  it('the two handlers agree on every case above', () => {
    // A page granted by one and refused by the other gets a stream it is then
    // told it does not have — worse than a clean refusal, because the dock
    // shows itself and hears nothing.
    const cases = [
      { origin: LOCAL, type: 'audio', main: true },
      { origin: LOCAL, type: 'audio', main: false },
      { origin: LOCAL, type: 'video', main: true },
      { origin: WEB, type: 'audio', main: true },
      { origin: 'http://localhost.evil.com/', type: 'audio', main: true },
      { origin: 'http://localhost:5173/', type: 'audio', main: true }
    ]
    for (const c of cases) {
      const asked = request('media', {
        securityOrigin: c.origin,
        mediaTypes: [c.type],
        isMainFrame: c.main
      })
      const checked = check('media', c.origin, { mediaType: c.type, isMainFrame: c.main })
      expect({ ...c, asked, checked }).toEqual({ ...c, asked, checked: asked })
    }
  })
})
