import { useCallback, useEffect, useRef, useState } from 'react'
import { detectLocalhostUrl, stripAnsi } from '../lib/localhost-url'

/**
 * State machine for toolbar server buttons (terminals declaring a `serverUrl`).
 *
 * A server button is goal-directed: the click means "make this server exist and
 * take me to it", not "run the command again". The HTTP probe is the only
 * source of truth — session liveness is NOT server liveness (the popover shell
 * survives a Ctrl-C'd server, and a server can survive a Clave restart).
 *
 * Click algorithm:
 *   1. Probe the live URL (~500ms HTTP). Reachable → openExternal, done. This
 *      covers our own persistent session, a pre-restart orphan, or a server the
 *      user started by hand — and never spawns a duplicate.
 *   2. Not reachable → ensure a session (reattach + restart in place, or let
 *      the popover spawn one), then open on URL detection in output or on a
 *      successful probe during the starting window. A dead URL is never opened.
 *
 * Known residual, by design: an unrelated process answering on the declared
 * port passes the probe (port hijack) — we do not engineer around it.
 */

export type ServerButtonState = 'unknown' | 'up' | 'down' | 'starting'

export interface ServerButtonApi {
  state: ServerButtonState
  /** Adopted (detected) URL if the server hopped ports, else the declared one. */
  liveUrl: string | null
  /** Probe-first "ensure running, then open" click. */
  handleClick: () => void
  /** Show the popover terminal only — no probe, no browser (⌥/right-click). */
  openTerminalOnly: () => void
  /** Open liveUrl in the browser (header chip) — only acts when state is 'up'. */
  openBrowser: () => void
  title: string
}

const PROBE_TIMEOUT_MS = 500
const DOT_POLL_INTERVAL_MS = 10_000
const STARTING_PROBE_INTERVAL_MS = 2_000
const STARTING_TIMEOUT_MS = 60_000
const RESTART_SIGINT_DELAY_MS = 150
/** Consecutive probe failures before an 'up' dot demotes to 'down' (HMR flap guard). */
const DEMOTE_FAILURES = 2

interface UseServerButtonArgs {
  /** Declared server URL; undefined disables the whole state machine. */
  serverUrl?: string
  command: string
  /** The popover's current session id (persists across popover close). */
  sessionId: string | null
  /** Live persistent session id, nulled the moment its PTY exits. */
  getLiveSessionId: () => string | null
  /** Open the popover, spawning a session if none is alive. */
  openTerminal: () => void
}

export function useServerButton({
  serverUrl,
  command,
  sessionId,
  getLiveSessionId,
  openTerminal
}: UseServerButtonArgs): ServerButtonApi {
  const enabled = !!serverUrl
  const [state, setState] = useState<ServerButtonState>('unknown')
  const [adoptedUrl, setAdoptedUrl] = useState<string | null>(null)
  const liveUrl = enabled ? (adoptedUrl ?? serverUrl!) : null

  const stateRef = useRef(state)
  const liveUrlRef = useRef(liveUrl)
  useEffect(() => {
    stateRef.current = state
    liveUrlRef.current = liveUrl
  }, [state, liveUrl])
  /** One consumable browser-open per click — streaming output can never re-trigger it. */
  const intentRef = useRef(false)
  const bufferRef = useRef('')
  const failuresRef = useRef(0)
  const startingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const clearStarting = useCallback(() => {
    if (startingTimerRef.current) {
      clearTimeout(startingTimerRef.current)
      startingTimerRef.current = null
    }
    if (startingIntervalRef.current) {
      clearInterval(startingIntervalRef.current)
      startingIntervalRef.current = null
    }
  }, [])

  /** The server answered at `url` — settle 'up', consume the open intent if armed. */
  const resolveUp = useCallback(
    (url: string) => {
      clearStarting()
      failuresRef.current = 0
      setAdoptedUrl(url)
      setState('up')
      if (intentRef.current) {
        intentRef.current = false
        window.electronAPI.openExternal(url)
      }
    },
    [clearStarting]
  )

  const failStarting = useCallback(() => {
    clearStarting()
    intentRef.current = false
    setState('down')
  }, [clearStarting])

  /** Dot-maintenance probe (mount, interval, window focus). Never runs while starting. */
  const probeNow = useCallback(async () => {
    if (!enabled || stateRef.current === 'starting') return
    const target = liveUrlRef.current
    if (!target) return
    const ok = await window.electronAPI.probeServerUrl(target, PROBE_TIMEOUT_MS)
    // Re-read after the await — a click may have flipped us to 'starting'.
    if ((stateRef.current as ServerButtonState) === 'starting') return
    if (ok) {
      failuresRef.current = 0
      setState('up')
    } else {
      failuresRef.current++
      if (stateRef.current !== 'up' || failuresRef.current >= DEMOTE_FAILURES) {
        failuresRef.current = 0
        setState('down')
      }
    }
  }, [enabled])

  /** Starting-window probe against the declared URL — covers servers that never
   *  print their URL (or print it ANSI-mangled past detection). */
  const probeStartingOnce = useCallback(
    async (failFast: boolean) => {
      if (!enabled || stateRef.current !== 'starting') return
      const ok = await window.electronAPI.probeServerUrl(serverUrl!, PROBE_TIMEOUT_MS)
      if (stateRef.current !== 'starting') return
      if (ok) resolveUp(serverUrl!)
      else if (failFast) failStarting()
    },
    [enabled, serverUrl, resolveUp, failStarting]
  )

  // Output detection on the live session — primary "server is up" signal, and
  // the one that catches port hops (mint 3000 → 3001): detection wins over
  // declaration, the detected URL is adopted for the rest of the app run.
  useEffect(() => {
    if (!enabled || !sessionId) return
    const cleanupData = window.electronAPI.onSessionData(sessionId, (data) => {
      bufferRef.current = (bufferRef.current + stripAnsi(data)).slice(-500)
      const url = detectLocalhostUrl(bufferRef.current)
      if (!url) return
      if (stateRef.current === 'starting') {
        resolveUp(url)
      } else if (url !== liveUrlRef.current || stateRef.current !== 'up') {
        // Manual restart inside the popover — adopt quietly, never open a browser.
        failuresRef.current = 0
        setAdoptedUrl(url)
        setState('up')
      }
    })
    const cleanupExit = window.electronAPI.onSessionExit(sessionId, () => {
      // Session death ≠ server death — but a session dying mid-start usually
      // means the command failed fast (e.g. not found). Learn the truth quickly
      // instead of sitting amber for the full timeout.
      if (stateRef.current === 'starting') {
        setTimeout(() => void probeStartingOnce(true), 800)
      }
    })
    return () => {
      cleanupData()
      cleanupExit()
    }
  }, [enabled, sessionId, resolveUp, probeStartingOnce])

  // Dot maintenance: probe on mount, every 10s while the app is focused, and
  // immediately on window refocus (user may have killed the server elsewhere).
  useEffect(() => {
    if (!enabled) return
    const initialProbe = setTimeout(() => void probeNow(), 0)
    const interval = setInterval(() => {
      if (!document.hasFocus()) return
      void probeNow()
    }, DOT_POLL_INTERVAL_MS)
    const onFocus = (): void => {
      void probeNow()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      clearTimeout(initialProbe)
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      clearStarting()
    }
  }, [enabled, probeNow, clearStarting])

  const handleClick = useCallback(async () => {
    if (!enabled) return
    const target = liveUrlRef.current!
    const ok = await window.electronAPI.probeServerUrl(target, PROBE_TIMEOUT_MS)
    if (ok) {
      // The probe is the only source of truth: reachable → just go there.
      failuresRef.current = 0
      setState('up')
      window.electronAPI.openExternal(target)
      return
    }
    if (stateRef.current === 'starting') {
      // Already booting — surface the logs, never ^C a starting server.
      openTerminal()
      return
    }
    // Not reachable → ensure running. Reset adoption so the starting window
    // probes the declared URL, and reset the buffer so a stale URL lingering
    // in old output can never satisfy detection.
    setAdoptedUrl(null)
    liveUrlRef.current = serverUrl!
    bufferRef.current = ''
    intentRef.current = true
    setState('starting')
    const sid = getLiveSessionId()
    openTerminal()
    if (sid) {
      // Restart in place: ^C clears a half-typed prompt line or kills a wedged
      // foreground process; scrollback (the evidence of why it died) survives.
      window.electronAPI.writeSession(sid, '\x03')
      setTimeout(() => {
        window.electronAPI.writeSession(sid, command + '\r')
      }, RESTART_SIGINT_DELAY_MS)
    }
    // Else: openTerminal() spawns a fresh session that runs `command` itself.
    startingIntervalRef.current = setInterval(() => {
      void probeStartingOnce(false)
    }, STARTING_PROBE_INTERVAL_MS)
    startingTimerRef.current = setTimeout(() => {
      // Last-chance probe before giving up — still a bounded response to the click.
      void probeStartingOnce(true)
    }, STARTING_TIMEOUT_MS)
  }, [enabled, serverUrl, command, getLiveSessionId, openTerminal, probeStartingOnce])

  const openTerminalOnly = useCallback(() => {
    openTerminal()
  }, [openTerminal])

  const openBrowser = useCallback(() => {
    if (stateRef.current === 'up' && liveUrlRef.current) {
      window.electronAPI.openExternal(liveUrlRef.current)
    }
  }, [])

  const title = !enabled
    ? command || 'Shell'
    : state === 'up'
      ? `Open ${liveUrl}\n⌥-click / right-click: terminal`
      : state === 'starting'
        ? `Starting ${command}…`
        : `Start ${command} → ${serverUrl}\n⌥-click / right-click: terminal`

  return {
    state,
    liveUrl,
    handleClick: () => void handleClick(),
    openTerminalOnly,
    openBrowser,
    title
  }
}
