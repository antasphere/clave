import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  ArrowTopRightOnSquareIcon,
  GlobeAltIcon,
  HomeIcon
} from '@heroicons/react/24/outline'
import { AnimatePresence, motion } from 'framer-motion'
import { PageGuest, type PageGuestHandle, type PageTrail } from './PageGuest'
import { ViewNotice } from './ViewNotice'
import { usePreviewUrl } from '../../hooks/use-preview-url'
import { useFileChanged } from '../../hooks/use-file-changed'
import { isAtHome, PREVIEW_PROTOCOL } from '../../../../shared/view-navigation'

const PROBE_TIMEOUT_MS = 500
const PROBE_INTERVAL_MS = 10_000
const STARTING_PROBE_INTERVAL_MS = 2_000
/** How long a start runs before the pane offers a way in (the terminal) and a
 *  way out (a restart). It never gives up on its own: the serving command is
 *  still running, and a board's `exos board refresh` alone is forty seconds
 *  on a good day and two minutes behind the worker's timeout. Giving up at
 *  60 s used to hand the user the same Start button, whose click sent ^C
 *  into the refresh in flight — a slow board never came up at all. */
const STARTING_PATIENCE_MS = 45_000
const ELAPSED_TICK_MS = 1_000

type ProbeState = 'unknown' | 'up' | 'down' | 'starting'

/** The action that serves a view's page when the probe says nobody does. */
export interface WebViewPaneStart {
  /** The serving command, named on the button ("Start <command>"). */
  command: string
  run: () => Promise<void>
  /** Run it unasked the first time the probe finds the server down — the
   *  declaration said auto-run, and a group opened on its board wants the
   *  board, not a dead page and a button. Once per page: a server that dies
   *  later is a click, never a loop. */
  auto?: boolean
  /** Bring the serving terminal on screen: the only honest progress report
   *  for a start that takes its time. Absent when there is no terminal to
   *  show (nothing spawned yet, or a hidden serving session). */
  show?: () => void
}

export interface WebViewPaneProps {
  /** http(s) URL (probed) or an absolute .html path (served from disk, no probe). */
  url: string
  title: string
  /** Label of the segmented button that leaves the view ("Sessions", "Terminal"). */
  backLabel: string
  onBack: () => void
  /** The start action shown when the probe says down; null = no way to start. */
  start: WebViewPaneStart | null
  /** False while the pane is mounted but hidden behind whatever the user is
   *  actually looking at. The frame stays alive (that is the whole point of
   *  keeping it mounted), but a pane nobody can see stops polling its server. */
  active?: boolean
}

const homePath = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~')

/**
 * The rendered page a view carries — fills the main pane in place of what the
 * sidebar item normally shows (a group's session mosaic, a session's terminal).
 * An http(s) url (a dev server, a workstream dashboard) embeds live; an
 * absolute .html path is served from disk through the clave-preview protocol.
 * Both render in the same web-view guest (PageGuest). For servers, an HTTP
 * probe keeps the pane honest: a dead server shows a start action wired to
 * whatever serves it, not a broken frame.
 *
 * A start is patient. The pane stays "starting" for as long as the command
 * runs, counting the seconds, polling fast, and mounting the frame the moment
 * the server answers; past STARTING_PATIENCE_MS it adds the terminal and a
 * restart to the notice rather than pretending the server died. A start that
 * fails to spawn says why. An `auto` start runs once, unasked, on the first
 * probe that finds the server down.
 *
 * The declared url is the view's HOME, and the page is free to link away from
 * it: an exos wave page links its lanes, a board links its cycles, a report on
 * disk links its siblings. The guest keeps that trail as a history of its own,
 * so the header carries what a page that links needs — back, forward, home —
 * and names the page the reader is actually on rather than the one the sidebar
 * declared. Which links stay in the pane and which leave for the browser is
 * the main process's rule (view-guests.ts). The trail is the reader's and is
 * never persisted; the guest's cookies and storage are (one shared browser
 * profile for every view, so a dashboard's sign-in survives a restart).
 * Extracted from the group view panel so session views share one
 * probe/header/frame implementation.
 */
export function WebViewPane({
  url,
  title,
  backLabel,
  onBack,
  start,
  active = true
}: WebViewPaneProps): React.JSX.Element {
  const isFile = url.startsWith('/')
  const [probe, setProbe] = useState<ProbeState>(isFile ? 'up' : 'unknown')
  const [nonce, setNonce] = useState(0)
  // The frame whose page has painted: a served page keeps the notice over it
  // until its first load ends, and a remount (a new nonce) is a new wait.
  const [loadedNonce, setLoadedNonce] = useState(-1)
  const loaded = loadedNonce === nonce
  const probeRef = useRef(probe)
  useEffect(() => {
    probeRef.current = probe
  }, [probe])
  // The start in progress: when it began (the notice counts from it), how
  // many were asked for (the button reads Restart after the first), and why
  // the last one could not even spawn.
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [attempts, setAttempts] = useState(0)
  const [startError, setStartError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // The start action and its trigger, reachable from the probe without
  // re-creating it: the start object is rebuilt by every render of the panel.
  const startRef = useRef(start)
  useEffect(() => {
    startRef.current = start
  }, [start])
  const handleStartRef = useRef<() => void>(() => {})
  // The auto start: once per page, on the first probe that finds it down. A
  // server that dies later, or a start that fails, is back to a click — the
  // guard is what keeps a permanently failing command from spawning in a loop.
  const autoStartedFor = useRef<string | null>(null)

  const probeNow = useCallback(async () => {
    if (isFile || !url) return
    const ok = await window.electronAPI.probeServerUrl(url, PROBE_TIMEOUT_MS)
    if (probeRef.current === 'starting') {
      // A start ends when the server answers — never on a clock. The command
      // is still running; the notice says for how long.
      if (ok) {
        setStartedAt(null)
        setProbe('up')
        setNonce((n) => n + 1)
      }
      return
    }
    setProbe((prev) => {
      if (ok && prev !== 'up') setNonce((n) => n + 1)
      return ok ? 'up' : 'down'
    })
    if (!ok && startRef.current?.auto && autoStartedFor.current !== url) {
      autoStartedFor.current = url
      handleStartRef.current()
    }
  }, [isFile, url])

  // Probe on mount and keep the dot honest while the app is focused; the
  // starting window polls faster so a booting server appears promptly. A hidden
  // pane polls nothing and picks it up again on the probe this effect runs when
  // it comes back — the frame it is holding open costs nothing to leave alone.
  useEffect(() => {
    if (isFile || !active) return
    const initialProbe = setTimeout(() => void probeNow(), 0)
    const interval = setInterval(() => {
      if (probeRef.current !== 'starting' && !document.hasFocus()) return
      void probeNow()
    }, PROBE_INTERVAL_MS)
    const fastInterval = setInterval(() => {
      if (probeRef.current === 'starting') void probeNow()
    }, STARTING_PROBE_INTERVAL_MS)
    const onFocus = (): void => void probeNow()
    window.addEventListener('focus', onFocus)
    return () => {
      clearTimeout(initialProbe)
      clearInterval(interval)
      clearInterval(fastInterval)
      window.removeEventListener('focus', onFocus)
    }
  }, [isFile, active, probeNow])

  // The elapsed on the starting notice, ticking once a second while a start
  // runs (handleStart sets the first reading, with the start's own moment).
  useEffect(() => {
    if (probe !== 'starting') return
    const tick = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(tick)
  }, [probe])

  // A file page is served at a clave-preview url; that url is its home.
  const preview = usePreviewUrl(isFile ? url : null)
  const home = isFile ? preview.url : url
  const showFrame = isFile ? !!preview.url : probe === 'up'

  const guestRef = useRef<PageGuestHandle | null>(null)
  // The trail carries the home it was read against: a file page's home is
  // only known once the main process has served it, and a trail read against
  // an earlier home (or the declared path) is not this page's trail.
  const [trail, setTrail] = useState<PageTrail & { home: string | null }>({
    url: home ?? url,
    title: '',
    canGoBack: false,
    canGoForward: false,
    home
  })
  const onTrail = useCallback((t: PageTrail) => setTrail({ ...t, home }), [home])
  const current: PageTrail =
    trail.home === home
      ? trail
      : { url: home ?? url, title: '', canGoBack: false, canGoForward: false }
  const atHome = !home || isAtHome(home, current.url)

  // A file page follows its file: a report an agent is rewriting reloads in
  // place, where the reader is.
  useFileChanged(isFile ? url : null, () => guestRef.current?.reload())

  const handleStart = useCallback(() => {
    if (!start) return
    const at = Date.now()
    setStartedAt(at)
    setNow(at)
    setStartError(null)
    setAttempts((n) => n + 1)
    setProbe('starting')
    start.run().catch((err: unknown) => {
      // Nothing is running: say why, and hand the button back.
      setStartedAt(null)
      setStartError(err instanceof Error ? err.message : String(err))
      setProbe('down')
    })
  }, [start])
  useEffect(() => {
    handleStartRef.current = handleStart
  }, [handleStart])

  // Reload reloads the page the reader is ON — the trail survives. A frame the
  // probe has not brought up yet remounts instead.
  const handleRefresh = useCallback(() => {
    if (showFrame && guestRef.current) {
      guestRef.current.reload()
      if (!isFile) void probeNow()
      return
    }
    setNonce((n) => n + 1)
    if (!isFile) void probeNow()
  }, [isFile, showFrame, probeNow])

  const handleOpenExternal = useCallback(() => {
    if (isFile && atHome) window.electronAPI.openPath(url)
    else window.electronAPI.openExternal(current.url || url)
  }, [isFile, atHome, url, current.url])

  // The header names the page the reader is on: the declared title at home,
  // the guest's own title once the reader has followed a link. The address
  // line shows a file page as a path: at home the file's own, away in the
  // same folder its sibling's (same token, same folder — the protocol's rule).
  const shownTitle = atHome || !current.title ? title : current.title
  const shownUrl = ((): string => {
    if (!isFile) return current.url || url
    if (atHome) return homePath(url)
    try {
      const c = new URL(current.url)
      if (c.protocol === PREVIEW_PROTOCOL) {
        const dir = homePath(url).replace(/\/[^/]*$/, '')
        return dir + decodeURIComponent(c.pathname)
      }
    } catch {
      // not a url — show it as it is
    }
    return current.url
  })()

  // The notice under a page that is not up: what is happening, for how long,
  // and what the reader can do about it.
  const elapsedMs = startedAt !== null ? now - startedAt : 0
  const starting = probe === 'starting'
  const patient = starting && elapsedMs >= STARTING_PATIENCE_MS
  const noticeState = probe === 'unknown' ? 'checking' : starting ? 'starting' : 'down'

  return (
    <div className="h-full flex flex-col floating-card overflow-hidden">
      {/* Header — the trail, title, source, and the way back to what the item normally shows */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle flex-shrink-0 bg-surface-0">
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={() => guestRef.current?.back()}
            disabled={!current.canGoBack}
            className="btn-icon"
            title="Back"
            data-testid="view-nav-back"
          >
            <ArrowLeftIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => guestRef.current?.forward()}
            disabled={!current.canGoForward}
            className="btn-icon"
            title="Forward"
            data-testid="view-nav-forward"
          >
            <ArrowRightIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => guestRef.current?.home()}
            disabled={atHome}
            className="btn-icon"
            title="Home"
            data-testid="view-nav-home"
          >
            <HomeIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <GlobeAltIcon className="w-4 h-4 text-text-tertiary flex-shrink-0" />
          <span
            className="text-sm font-medium text-text-primary truncate flex-shrink-0 max-w-[40%]"
            data-testid="view-title"
          >
            {shownTitle}
          </span>
          <span
            className="text-[11px] text-text-tertiary truncate hidden sm:inline flex-1 min-w-0"
            data-testid="view-current-url"
          >
            {shownUrl}
          </span>
          {!isFile && (
            <span
              className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{
                backgroundColor:
                  probe === 'up' ? '#4cb782' : probe === 'starting' ? '#e8b931' : '#d45461'
              }}
              title={
                probe === 'up' ? 'Server up' : probe === 'starting' ? 'Starting…' : 'Server down'
              }
            />
          )}
        </div>
        <div className="segmented flex-shrink-0">
          <button className="segmented-item" data-active={true}>
            View
          </button>
          <button className="segmented-item" onClick={onBack}>
            {backLabel}
          </button>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={handleRefresh} className="btn-icon" title="Reload">
            <ArrowPathIcon className="w-4 h-4" />
          </button>
          <button
            onClick={handleOpenExternal}
            className="btn-icon"
            title={isFile && atHome ? 'Open externally' : 'Open in browser'}
          >
            <ArrowTopRightOnSquareIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 relative">
        {isFile && preview.error ? (
          <div className="px-4 py-8 text-center text-sm text-text-tertiary">
            Failed to render page
            <div className="mt-1 text-xs">{preview.error}</div>
          </div>
        ) : showFrame && home ? (
          <>
            {/* Keyed by nonce: a remount is a new history, which is what a
                server coming back up wants and a Reload does not. */}
            <PageGuest
              key={nonce}
              ref={guestRef}
              src={home}
              title={title}
              onTrail={onTrail}
              onFirstLoad={() => setLoadedNonce(nonce)}
            />
            {/* A served page keeps the notice over the frame until it has
                painted once, then lets it fade — no white flash, no half-built
                dashboard. A file page paints at once and never needs it. */}
            <AnimatePresence>
              {!isFile && !loaded && (
                <motion.div
                  key={`veil-${nonce}`}
                  className="absolute inset-0 z-10"
                  initial={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                >
                  <ViewNotice state="loading" title={title} url={url} command={start?.command} />
                </motion.div>
              )}
            </AnimatePresence>
          </>
        ) : isFile ? (
          <div className="px-4 py-8 text-center text-sm text-text-tertiary">Loading…</div>
        ) : (
          <ViewNotice
            state={noticeState}
            title={title}
            url={url}
            elapsedMs={elapsedMs}
            patient={patient}
            command={start?.command}
            error={startError}
            startLabel={attempts > 0 ? 'Restart' : 'Start'}
            onStart={start ? handleStart : undefined}
            onShowTerminal={start?.show}
            onRetry={() => void probeNow()}
          />
        )}
      </div>
    </div>
  )
}
