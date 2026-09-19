import { useCallback, useEffect, useRef, useState } from 'react'
import { MicrophoneIcon } from '@heroicons/react/24/outline'
import { cn } from '../../lib/utils'
import type { MicAccessState } from '../../../../shared/mic'
import { resolveMicBanner, type MeterPhase, type MicBanner } from './mic-banner'
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsCallout
} from './primitives'

/**
 * The Audio page: which microphone a page shown in Clave will be handed, what
 * it is hearing right now, and where the system permission stands.
 *
 * It reports; it does not route. Chromium always hands a page the input macOS
 * calls default and Electron has no say in it, so a picker here would have
 * looked like it chose and would not have. The page names the default instead
 * and links to where it is actually changed.
 *
 * The meter is a live check, open only while this page is mounted and released
 * on leave. It is ALWAYS on screen: when something is wrong a banner appears
 * under it (see `mic-banner.ts` for the state machine), never in place of it.
 * Recovery is automatic — the status is re-read when the window is focused
 * again (the user coming back from System Settings) and the stream re-opened
 * once the OS says yes.
 *
 * Ported from Réplique (`app/src/renderer/src/components/settings/AudioSettings.tsx`),
 * the Electron app this surface was first built in.
 */

const METER_SEGMENTS = 24
/** The meter's log floor: -60 dBFS reads empty, 0 dBFS reads full. */
const METER_FLOOR_DB = -60
/** Exact digital silence for this long means the OS is withholding the signal. */
const SILENCE_WATCHDOG_MS = 3000

interface MeterReading {
  /** Lit segments, smoothed. */
  level: number
  /** Peak-hold segment index; 0 = none. */
  peak: number
}

function rmsToSegments(rms: number): number {
  if (rms <= 0) return 0
  const db = 20 * Math.log10(rms)
  const norm = Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB))
  return Math.round(norm * METER_SEGMENTS)
}

/**
 * Owns the meter's stream (opened on mount and on a recovery attempt, released
 * on unmount) and the OS permission snapshot that drives the banner. Returns
 * the reading already quantised to segments, so React re-renders when a
 * segment changes rather than sixty times a second.
 */
function useMicMeter(): {
  phase: MeterPhase
  deviceLabel: string | null
  reading: MeterReading
  access: MicAccessState | null
  requestAccess: () => void
  openSettings: () => void
} {
  const [phase, setPhase] = useState<MeterPhase>('starting')
  const [deviceLabel, setDeviceLabel] = useState<string | null>(null)
  const [reading, setReading] = useState<MeterReading>({ level: 0, peak: 0 })
  const readingRef = useRef(reading)
  const [access, setAccess] = useState<MicAccessState | null>(null)
  // Bumped to tear the stream down and open it again — recovery after a grant.
  const [attempt, setAttempt] = useState(0)

  // The live phase for the async recovery flow, without re-arming its listener.
  const phaseRef = useRef(phase)
  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  /**
   * Pulls the OS truth; when nothing forbids the microphone while the stream
   * sits in a problem state, opens it again. This is what brings the meter
   * back after a grant without restarting Clave.
   */
  const recover = useCallback(async (): Promise<void> => {
    let next: MicAccessState | null = null
    try {
      next = await window.electronAPI.getMicAccess()
      setAccess(next)
    } catch {
      // Main unreachable (never in normal life) — the stream's truth only.
    }
    const blocked =
      next !== null &&
      (next.status === 'denied' || next.status === 'restricted' || next.status === 'not-determined')
    const current = phaseRef.current
    if (!blocked && (current === 'denied' || current === 'unavailable' || current === 'silent')) {
      setAttempt((n) => n + 1)
    }
  }, [])

  // The status on mount, and again on every window refocus: the banner needs
  // no failed stream and no three-second watchdog to appear, or to clear.
  useEffect(() => {
    let alive = true
    window.electronAPI
      .getMicAccess()
      .then((s) => {
        if (alive) setAccess(s)
      })
      .catch(() => {})
    const onFocus = (): void => void recover()
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      window.removeEventListener('focus', onFocus)
    }
  }, [recover])

  /** The macOS prompt, when the OS can still ask, then the usual recovery. */
  const requestAccess = useCallback((): void => {
    void window.electronAPI
      .requestMicAccess()
      .catch(() => null)
      .then(() => recover())
  }, [recover])

  /** The OS privacy pane; refocus does the re-check on the way back. */
  const openSettings = useCallback((): void => {
    void window.electronAPI.openMicPrivacySettings().catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let rafId: number | null = null

    const start = async (): Promise<void> => {
      try {
        // No deviceId: this is deliberately the input a page shown in Clave
        // will be handed, which is the one macOS calls default.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            autoGainControl: false,
            echoCancellation: false,
            noiseSuppression: false
          }
        })
      } catch (error) {
        if (cancelled) return
        const name = error instanceof DOMException ? error.name : ''
        setPhase(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable')
        // The meter stays on screen in a problem state — make it read empty.
        readingRef.current = { level: 0, peak: 0 }
        setReading(readingRef.current)
        setDeviceLabel(null)
        return
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      // The track knows which device it actually got; a label is only
      // populated once the permission is granted, which it now is.
      setDeviceLabel(stream.getAudioTracks()[0]?.label || null)

      ctx = new AudioContext()
      // Chromium can hand back a suspended context, and a suspended context
      // reads eternal zeros without ever erroring.
      if (ctx.state !== 'running') void ctx.resume().catch(() => {})
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      ctx.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      let smoothed = 0
      let peakNorm = 0
      let silentSince: number | null = null
      setPhase('live')

      const tick = (): void => {
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
        // Exact digital silence is not a quiet room — a quiet room still has
        // dither noise. Zero means the OS is withholding the signal, which in
        // dev is the launching terminal lacking the permission.
        if (sum === 0) {
          if (silentSince === null) silentSince = performance.now()
          else if (performance.now() - silentSince > SILENCE_WATCHDOG_MS) setPhase('silent')
        } else if (silentSince !== null) {
          silentSince = null
          setPhase('live')
        }
        const rms = Math.sqrt(sum / samples.length)
        // Fast attack, slow decay — a meter has to feel like a meter.
        smoothed = rms > smoothed ? rms : smoothed * 0.92
        peakNorm = Math.max(peakNorm * 0.995, smoothed)
        const next: MeterReading = { level: rmsToSegments(smoothed), peak: rmsToSegments(peakNorm) }
        const prev = readingRef.current
        if (next.level !== prev.level || next.peak !== prev.peak) {
          readingRef.current = next
          setReading(next)
        }
        rafId = requestAnimationFrame(tick)
      }
      rafId = requestAnimationFrame(tick)
    }

    void start()

    // The default input changing under us (a headset plugged in) means the
    // stream we hold is no longer the one a page would be handed: open it
    // again so the meter and the name both tell the truth.
    const onDeviceChange = (): void => setAttempt((n) => n + 1)
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)

    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
      if (rafId !== null) cancelAnimationFrame(rafId)
      stream?.getTracks().forEach((track) => track.stop())
      void ctx?.close().catch(() => {})
    }
  }, [attempt])

  return { phase, deviceLabel, reading, access, requestAccess, openSettings }
}

const BANNER_TEXT: Record<MicBanner['kind'], { title: string; text: string }> = {
  ask: {
    title: 'Clave has not asked for the microphone yet',
    text: 'macOS decides whether an app may listen. Allow it once and pages you open in a view can use the microphone when you ask them to.'
  },
  denied: {
    title: 'macOS is refusing Clave the microphone',
    text: 'The permission was declined, or something on this Mac manages it. Turn Clave on under Privacy & Security, Microphone; the page picks it up when you come back.'
  },
  silent: {
    title: 'The microphone is allowed but sending nothing',
    text: 'The signal is exactly silent, which a real microphone in a quiet room never is: the system is withholding it rather than the room being quiet.'
  },
  noDevice: {
    title: 'No microphone to listen to',
    text: 'Nothing on this Mac is offering an audio input right now. Plug one in, or turn one on, and this page finds it.'
  }
}

const DEV_HINT =
  'Clave is running from source, so this permission belongs to whatever launched it, your terminal or your editor, not to Clave. A packaged Clave asks for itself.'

export function AudioSettings(): React.JSX.Element {
  const { phase, deviceLabel, reading, access, requestAccess, openSettings } = useMicMeter()
  const banner = resolveMicBanner(phase, access)

  const statusWord =
    access?.status === 'granted'
      ? 'Allowed'
      : access?.status === 'denied'
        ? 'Refused'
        : access?.status === 'restricted'
          ? 'Managed by this Mac'
          : access?.status === 'not-determined'
            ? 'Not asked yet'
            : 'Not known on this system'

  return (
    <SettingsPage
      title="Audio"
      description="The microphone a page shown in Clave will be handed, and what it is hearing."
      testId="audio"
    >
      <SettingsSection
        title="Microphone"
        description="Pages you open in a group or a tab view, such as a voice dock, are handed the input macOS calls default. Clave does not choose it; change it in System Settings, Sound."
      >
        <SettingsCard>
          <SettingsRow
            label="Input"
            description={
              deviceLabel ??
              (phase === 'starting' ? 'Looking…' : 'Not known until the microphone is allowed')
            }
          >
            <button
              className="btn-dialog"
              onClick={openSettings}
              disabled={!access?.canOpenSettings}
            >
              Sound settings
            </button>
          </SettingsRow>
          <SettingsRow label="Level" description="Speak, and the meter moves.">
            {/* Always the meter: a problem gets the banner below, never a
                replacement of the meter. */}
            <LevelMeter level={reading.level} peak={reading.peak} segments={METER_SEGMENTS} />
          </SettingsRow>
          <SettingsRow
            label="Permission"
            description="What macOS answers when Clave asks to listen."
          >
            <span className="status-text" data-mic-status={access?.status ?? 'unknown'}>
              {statusWord}
            </span>
          </SettingsRow>
        </SettingsCard>

        {banner && (
          <SettingsCallout
            tone={
              banner.kind === 'ask' ? 'accent' : banner.kind === 'noDevice' ? undefined : 'danger'
            }
            className="mt-2"
            title={
              <span className="flex items-center gap-1.5">
                <MicrophoneIcon className="w-4 h-4 flex-shrink-0 opacity-70" />
                {BANNER_TEXT[banner.kind].title}
              </span>
            }
            text={
              <>
                {BANNER_TEXT[banner.kind].text}
                {banner.devHint && <span className="block mt-1">{DEV_HINT}</span>}
              </>
            }
          >
            {banner.action === 'request' && (
              <button className="btn-primary mt-2" onClick={requestAccess}>
                Allow the microphone
              </button>
            )}
            {banner.action === 'openSettings' && (
              <button className="btn-dialog mt-2" onClick={openSettings}>
                Open Privacy settings
              </button>
            )}
          </SettingsCallout>
        )}
      </SettingsSection>
    </SettingsPage>
  )
}

function LevelMeter({
  level,
  peak,
  segments
}: {
  level: number
  peak: number
  segments: number
}): React.JSX.Element {
  return (
    <div
      className="flex items-end gap-[3px]"
      role="img"
      aria-label="Microphone level"
      data-mic-meter
    >
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className={cn(
            'w-[4px] rounded-sm transition-colors duration-75',
            i < level
              ? 'bg-[var(--color-accent)]'
              : i < peak
                ? 'bg-[color-mix(in_srgb,var(--color-accent)_40%,transparent)]'
                : 'bg-[var(--surface-300)]'
          )}
          style={{ height: 7 + (i % 3) * 3 }}
        />
      ))}
    </div>
  )
}
