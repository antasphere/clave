import type { MicAccessState } from '../../../../shared/mic'
import type { MeterPhase } from './mic-banner'

/**
 * The two stateful decisions behind the Audio page's meter, pulled out of the
 * React hook so they can be tested without a microphone, an AudioContext or a
 * window. Both were found by an independent verifier as untested behaviour
 * where a regression is silent.
 */

/** The meter's log floor: -60 dBFS reads empty, 0 dBFS reads full. */
export const METER_FLOOR_DB = -60
/** Exact digital silence for this long means the OS is withholding the signal. */
export const SILENCE_WATCHDOG_MS = 3000

export function rmsToSegments(rms: number, segments: number): number {
  if (rms <= 0) return 0
  const db = 20 * Math.log10(rms)
  const norm = Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB))
  return Math.round(norm * segments)
}

/**
 * Watches for the signal being withheld rather than the room being quiet.
 *
 * Exact digital silence is the tell: a real microphone in a silent room still
 * carries dither noise, so a sum of exactly zero means the system is feeding
 * zeros. It has to be LATCHED — without that the report fires on every
 * animation frame, measured at 419 times over ten seconds of silence where
 * one is right — and it has to RE-ARM when sound returns, or a second stretch
 * of silence is never reported and the page stops telling the truth.
 */
export class SilenceWatchdog {
  private silentSince: number | null = null
  private reported = false

  /**
   * One frame. `sum` is the sum of squares of the samples, `now` its moment.
   * Returns the phase to move to, or null to stay where it is.
   */
  frame(sum: number, now: number): MeterPhase | null {
    if (sum === 0) {
      if (this.silentSince === null) {
        this.silentSince = now
        return null
      }
      if (!this.reported && now - this.silentSince > SILENCE_WATCHDOG_MS) {
        this.reported = true
        return 'silent'
      }
      return null
    }
    if (this.silentSince === null) return null
    // Sound is back: forget this stretch, and be ready to report the next one.
    this.silentSince = null
    const wasReported = this.reported
    this.reported = false
    return wasReported ? 'live' : null
  }
}

/**
 * Should the meter open its stream again, having just re-read the OS status?
 *
 * `unavailable` is deliberately NOT retried: it means there is no microphone
 * to open, which returning to the window does not change, and retrying asked
 * the system for a device on every focus. A device actually arriving fires
 * `devicechange`, which is what re-opens the stream — so nobody is stranded.
 */
export function shouldReopenStream(phase: MeterPhase, access: MicAccessState | null): boolean {
  const blocked =
    access !== null &&
    (access.status === 'denied' ||
      access.status === 'restricted' ||
      access.status === 'not-determined')
  if (blocked) return false
  return phase === 'denied' || phase === 'silent'
}
