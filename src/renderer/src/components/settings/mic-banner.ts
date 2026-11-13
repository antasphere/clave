import type { MicAccessState } from '../../../../shared/mic'

/**
 * The Audio page's banner, pure so it can be tested without a microphone or an
 * AudioContext. Two sources of truth feed it:
 *
 * - The OS permission status, from main. Proactive: when the system already
 *   says the permission is missing, the banner shows at once, without waiting
 *   for the meter's own stream to fail or the silence watchdog to fire.
 * - What actually happened when the meter opened its stream. The fallback for
 *   platforms with no queryable status, and for the granted-but-silent case
 *   that no status can describe.
 *
 * The banner never replaces the level meter; it renders under it.
 *
 * Ported from Réplique (`app/src/renderer/src/components/settings/mic-banner.ts`).
 */

/** What the meter's own attempt at a stream found. */
export type MeterPhase = 'starting' | 'live' | 'silent' | 'denied' | 'unavailable'

export type MicBannerKind = 'ask' | 'denied' | 'silent' | 'noDevice'

export type MicBannerAction = 'request' | 'openSettings' | null

export interface MicBanner {
  kind: MicBannerKind
  action: MicBannerAction
  /** The second line: unpackaged macOS, where the permission is the launcher's. */
  devHint: boolean
}

export function resolveMicBanner(
  phase: MeterPhase,
  access: MicAccessState | null
): MicBanner | null {
  const status = access?.status ?? 'unknown'
  const canOpen = access?.canOpenSettings ?? false
  const devHint = access?.devPermissionCaveat ?? false
  const settingsAction: MicBannerAction = canOpen ? 'openSettings' : null

  // The OS status first: it is the truth, and it needs no three-second wait.
  if (status === 'not-determined') return { kind: 'ask', action: 'request', devHint }
  if (status === 'denied' || status === 'restricted') {
    return { kind: 'denied', action: settingsAction, devHint }
  }
  // The stream's own evidence, from here on (status granted or unknown).
  if (phase === 'denied') return { kind: 'denied', action: settingsAction, devHint }
  if (phase === 'unavailable') return { kind: 'noDevice', action: null, devHint: false }
  if (phase === 'silent') return { kind: 'silent', action: settingsAction, devHint }
  return null
}
