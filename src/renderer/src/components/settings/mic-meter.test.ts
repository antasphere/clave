import { describe, it, expect } from 'vitest'
import {
  SilenceWatchdog,
  shouldReopenStream,
  rmsToSegments,
  SILENCE_WATCHDOG_MS
} from './mic-meter'
import type { MicAccessState } from '../../../../shared/mic'

const access = (status: MicAccessState['status']): MicAccessState => ({
  status,
  devPermissionCaveat: false,
  canOpenSettings: true
})

/** Sixty frames a second, the rate the meter really runs at. */
const FRAME_MS = 1000 / 60

describe('SilenceWatchdog', () => {
  it('says nothing while sound is coming in', () => {
    const w = new SilenceWatchdog()
    for (let t = 0; t < 5000; t += FRAME_MS) expect(w.frame(0.01, t)).toBeNull()
  })

  it('waits out the window before reporting silence', () => {
    const w = new SilenceWatchdog()
    let reportedAt: number | null = null
    for (let t = 0; t < 5000; t += FRAME_MS) {
      if (w.frame(0, t) === 'silent' && reportedAt === null) reportedAt = t
    }
    expect(reportedAt).not.toBeNull()
    expect(reportedAt!).toBeGreaterThan(SILENCE_WATCHDOG_MS)
    expect(reportedAt!).toBeLessThan(SILENCE_WATCHDOG_MS + 100)
  })

  it('reports silence ONCE, not on every frame', () => {
    // The defect this pins: unlatched, this counted 419 reports over ten
    // seconds where one is correct.
    const w = new SilenceWatchdog()
    let reports = 0
    for (let t = 0; t < 10_000; t += FRAME_MS) {
      if (w.frame(0, t) === 'silent') reports += 1
    }
    expect(reports).toBe(1)
  })

  it('re-arms when sound returns, so a SECOND silence is reported too', () => {
    // The other half, and the one that stranded a user: a latch that never
    // resets means the page stops telling the truth after the first stretch.
    const w = new SilenceWatchdog()
    const seen: string[] = []
    let t = 0
    const run = (sum: number, ms: number): void => {
      for (let i = 0; i < ms; i += FRAME_MS, t += FRAME_MS) {
        const phase = w.frame(sum, t)
        if (phase) seen.push(phase)
      }
    }
    run(0, 5000) // silence → reported
    run(0.02, 1000) // sound → back to live
    run(0, 5000) // silence again → reported again
    expect(seen).toEqual(['silent', 'live', 'silent'])
  })

  it('does not announce a return to live it never left', () => {
    // A short dip under the window is not a state change, so it earns no
    // report in either direction.
    const w = new SilenceWatchdog()
    const seen: (string | null)[] = []
    let t = 0
    for (let i = 0; i < 30; i++, t += FRAME_MS) seen.push(w.frame(0, t))
    for (let i = 0; i < 30; i++, t += FRAME_MS) seen.push(w.frame(0.02, t))
    expect(seen.filter(Boolean)).toEqual([])
  })
})

describe('shouldReopenStream', () => {
  it('re-opens after the permission is granted, from either problem state', () => {
    expect(shouldReopenStream('denied', access('granted'))).toBe(true)
    expect(shouldReopenStream('silent', access('granted'))).toBe(true)
  })

  it('does not re-open while the OS still forbids it', () => {
    for (const status of ['denied', 'restricted', 'not-determined'] as const) {
      expect(shouldReopenStream('denied', access(status))).toBe(false)
      expect(shouldReopenStream('silent', access(status))).toBe(false)
    }
  })

  it('does not re-open when there is simply no microphone', () => {
    // `unavailable` means no device. Returning to the window does not conjure
    // one, and retrying asked the system for a device on every focus. A device
    // arriving fires devicechange, which is what re-opens the stream.
    expect(shouldReopenStream('unavailable', access('granted'))).toBe(false)
    expect(shouldReopenStream('unavailable', null)).toBe(false)
  })

  it('leaves a working meter alone', () => {
    expect(shouldReopenStream('live', access('granted'))).toBe(false)
    expect(shouldReopenStream('starting', access('granted'))).toBe(false)
  })
})

describe('rmsToSegments', () => {
  it('reads empty at silence and full at nought dBFS', () => {
    expect(rmsToSegments(0, 24)).toBe(0)
    expect(rmsToSegments(1, 24)).toBe(24)
  })

  it('puts the floor at the bottom and never goes below it', () => {
    expect(rmsToSegments(0.001, 24)).toBe(0)
    expect(rmsToSegments(0.0000001, 24)).toBe(0)
  })

  it('rises with the signal', () => {
    const quiet = rmsToSegments(0.01, 24)
    const loud = rmsToSegments(0.3, 24)
    expect(quiet).toBeGreaterThan(0)
    expect(loud).toBeGreaterThan(quiet)
  })
})
