import { describe, it, expect } from 'vitest'
import { resolveMicBanner, type MeterPhase } from './mic-banner'
import type { MicAccessState } from '../../../../shared/mic'

/**
 * The Audio page's banner. What matters here is that the OS status is believed
 * over the stream's evidence: a user who has not been asked yet must see the
 * ask button immediately, not after three seconds of a meter reading zero.
 */

const mac = (status: MicAccessState['status'], devHint = false): MicAccessState => ({
  status,
  devPermissionCaveat: devHint,
  canOpenSettings: true
})

/** Linux: a real status is not knowable and no privacy pane exists to open. */
const linux: MicAccessState = {
  status: 'unknown',
  devPermissionCaveat: false,
  canOpenSettings: false
}

const PHASES: MeterPhase[] = ['starting', 'live', 'silent', 'denied', 'unavailable']

describe('resolveMicBanner', () => {
  it('says nothing when the permission is granted and the meter is live', () => {
    expect(resolveMicBanner('live', mac('granted'))).toBeNull()
    expect(resolveMicBanner('starting', mac('granted'))).toBeNull()
  })

  it('asks as soon as the OS says it has never been asked, whatever the meter is doing', () => {
    for (const phase of PHASES) {
      expect(resolveMicBanner(phase, mac('not-determined'))).toEqual({
        kind: 'ask',
        action: 'request',
        devHint: false
      })
    }
  })

  it('sends the user to the privacy pane when the OS says denied or restricted', () => {
    for (const status of ['denied', 'restricted'] as const) {
      for (const phase of PHASES) {
        expect(resolveMicBanner(phase, mac(status))).toEqual({
          kind: 'denied',
          action: 'openSettings',
          devHint: false
        })
      }
    }
  })

  it('carries the dev caveat through, so the page blames the launcher and not Clave', () => {
    expect(resolveMicBanner('denied', mac('denied', true))).toMatchObject({ devHint: true })
    expect(resolveMicBanner('live', mac('not-determined', true))).toMatchObject({ devHint: true })
  })

  it('falls back to the stream when the OS has no answer', () => {
    expect(resolveMicBanner('denied', linux)).toEqual({
      kind: 'denied',
      // No privacy pane on this OS, so the banner explains and offers nothing.
      action: null,
      devHint: false
    })
    expect(resolveMicBanner('unavailable', linux)).toEqual({
      kind: 'noDevice',
      action: null,
      devHint: false
    })
    expect(resolveMicBanner('silent', linux)).toEqual({
      kind: 'silent',
      action: null,
      devHint: false
    })
    expect(resolveMicBanner('live', linux)).toBeNull()
  })

  it('reports a granted permission that is nonetheless feeding silence', () => {
    // The case no status can describe: macOS says yes, the stream reads exact
    // zeros. In dev that is the launching terminal lacking the permission.
    expect(resolveMicBanner('silent', mac('granted'))).toEqual({
      kind: 'silent',
      action: 'openSettings',
      devHint: false
    })
  })

  it('reports no device when the stream could not be opened at all', () => {
    expect(resolveMicBanner('unavailable', mac('granted'))).toEqual({
      kind: 'noDevice',
      action: null,
      devHint: false
    })
  })

  it('works before main has answered, on the stream alone', () => {
    expect(resolveMicBanner('live', null)).toBeNull()
    expect(resolveMicBanner('denied', null)).toEqual({
      kind: 'denied',
      action: null,
      devHint: false
    })
  })
})
