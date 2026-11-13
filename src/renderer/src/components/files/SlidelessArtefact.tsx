import { useEffect, useRef, useState } from 'react'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import type { Artefact } from '@clave/contract/artefacts/model'
import { initArtefacts, ownerOfSession, useArtefactStore } from '../../store/artefact-store'
import { useFleetStore } from '../../store/fleet-store'
import { serverNameOf } from '../../lib/drop-refusal'
import { startHoldLoop } from '../../lib/artefact-hold'
import { useFileChanged } from '../../hooks/use-file-changed'
import { HtmlPreviewFrame } from './HtmlPreviewFrame'
import { withVersion } from '../../lib/artefact-version'

/** How many times a minute the frame holds again a preview that died under it. */
const RESTART_LIMIT = 3

/**
 * The frame of a session's HTML artefact (PRDCT-4474). The server the
 * session runs on runs the Slideless preview and saves a version at each
 * finished turn: this frame only HOLDS the preview while it is mounted
 * (renewing the hold before its time runs out, releasing it on unmount) and
 * frames the address the window was given, the server's own loopback for a
 * session of this Mac, a forwarded port of this Mac for a session elsewhere.
 * Without a ready Slideless on that machine it says so, names the machine,
 * and shows the plain page under the card when the page is on this Mac.
 */
export function SlidelessArtefact({
  sessionId,
  artefact
}: {
  sessionId: string
  artefact: Artefact
}): React.JSX.Element {
  useEffect(() => initArtefacts(), [])
  const owner = ownerOfSession(sessionId)
  const own = owner === LOCAL_SERVER_ID
  const machine = useFleetStore((s) => (own ? 'this Mac' : serverNameOf(s.connections, owner)))
  const slideless = useArtefactStore((s) => s.slideless[owner])
  const install = useArtefactStore((s) => s.install)
  useEffect(() => useArtefactStore.getState().readSlideless(owner), [owner])
  const ready = slideless?.phase === 'ready'

  const [held, setHeld] = useState<{ openedAt: string; url?: string; error?: string } | null>(null)
  // Bumped when the server says the preview died: the hold is taken again
  // without its id, at most RESTART_LIMIT times a minute, so a preview that
  // keeps dying ends with a sentence on screen rather than a loop.
  // A session on another server: when that server goes away the frame loads
  // again, so the forward's own page says it cannot be reached rather than a
  // stale deck standing as if live; when it is back, the hold is renewed at
  // once (the server answers a new preview, the frame moves to it).
  const wake = useRef<(() => void) | null>(null)
  const [reloads, setReloads] = useState(0)
  useEffect(() => {
    if (own) return
    let connected = true
    return window.electronAPI.onFleetStatus((status) => {
      if (status.serverId !== owner) return
      const now = status.state === 'connected'
      if (now && !connected) wake.current?.()
      if (!now && connected) setReloads((r) => r + 1)
      connected = now
    })
  }, [own, owner])

  // A new open by the agent starts afresh: the count is per open.
  const openedAt = artefact.openedAt
  const [generation, setGeneration] = useState(0)
  const [gaveUpOn, setGaveUpOn] = useState<string | null>(null)
  const gaveUp = gaveUpOn === openedAt
  const restarts = useRef<{ openedAt: string; at: number[] }>({ openedAt, at: [] })
  useEffect(
    () =>
      window.electronAPI.artefacts.onPreviewExited((exited) => {
        if (exited !== sessionId) return
        const now = Date.now()
        const counted =
          restarts.current.openedAt === openedAt
            ? restarts.current.at.filter((t) => now - t < 60_000)
            : []
        if (counted.length >= RESTART_LIMIT) {
          setGaveUpOn(openedAt)
          return
        }
        restarts.current = { openedAt, at: [...counted, now] }
        setGeneration((g) => g + 1)
      }),
    [sessionId, openedAt]
  )

  useEffect(() => {
    if (gaveUp) return
    // One hold call at a time (`startHoldLoop`): a wake-up during a call in
    // flight runs one more call after it, never a second hold at once.
    const loop = startHoldLoop({
      hold: (holdId) => window.electronAPI.artefacts.hold(sessionId, holdId),
      release: (holdId) => window.electronAPI.artefacts.release(sessionId, holdId),
      onUrl: (url) =>
        setHeld((prev) =>
          prev?.url === url && prev.openedAt === openedAt ? prev : { openedAt, url }
        ),
      onRefused: (error) => setHeld({ openedAt, error })
    })
    wake.current = loop.wake
    return () => {
      wake.current = null
      loop.stop()
    }
  }, [sessionId, openedAt, generation, gaveUp, ready])

  // The plain page of this Mac follows its file while Slideless is not there.
  const [reloadKey, setReloadKey] = useState(0)
  useFileChanged(own && !ready ? artefact.page : null, () => setReloadKey((k) => k + 1))

  const url = held?.openedAt === openedAt ? held.url : undefined
  // Slideless's own bar is hidden (`bar=0`): the version shown is chosen, and
  // a version saved, from Clave's bar above (PRDCT-4494); `v` is that choice.
  const shown = useArtefactStore((s) => s.version[sessionId] ?? 'live')
  const framed = url ? withVersion(url, shown) : undefined
  if (ready && framed && !gaveUp)
    return (
      <iframe
        key={`${framed}#${reloads}`}
        src={framed}
        data-testid="slideless-artefact"
        // The preview runs on its own loopback origin, never the app's; its
        // deck sits in a sandboxed frame of its own inside it.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
        referrerPolicy="no-referrer"
        className="w-full h-full border-0 bg-white"
        title={artefact.title}
      />
    )

  const phase = slideless?.phase
  // The card below says why while Slideless is being installed or is not
  // there; the refusal of a hold is said whenever no card says it already,
  // which is also the case of a machine whose state could not be read (a
  // server older than this domain, or one that went away): never a blank pane.
  const carded = phase !== undefined && phase !== 'ready'
  const serveError = gaveUp
    ? 'it stopped again and again. Hide the panel and open it again to retry.'
    : !carded && held?.openedAt === openedAt
      ? held.error
      : undefined
  return (
    <div className="flex flex-col h-full">
      {phase && phase !== 'ready' && (
        <div
          className="linked-document-notice flex items-center gap-2"
          data-testid="slideless-install-card"
        >
          <span className="flex-1 min-w-0">
            {/* A server's page is not drawn under the card (below): the
                sentence says where it will show rather than what it will do. */}
            {phase === 'installing'
              ? own
                ? `Installing Slideless on ${machine}: this page will reload on every edit and keep a version each turn.`
                : `Installing Slideless on ${machine}: this page shows here once it is installed.`
              : phase === 'error'
                ? `Slideless could not be installed on ${machine}: ${slideless?.error ?? 'unknown error'}`
                : own
                  ? `Install Slideless on ${machine} to reload this page on every edit and keep a version each turn.`
                  : `Install Slideless on ${machine} to show this page here, reload it on every edit and keep a version each turn.`}
          </span>
          {phase !== 'installing' && (
            <button
              className="btn-primary btn-compact flex-shrink-0"
              onClick={() => void install(owner).catch(() => {})}
            >
              {phase === 'error' ? 'Try again' : 'Install Slideless'}
            </button>
          )}
        </div>
      )}
      {serveError && (
        <div className="linked-document-notice" role="alert">
          Slideless could not show this page: {serveError}
        </div>
      )}
      {/* A server's page is a file of the server's disk: only this Mac's is shown plain. */}
      {own && (
        <div className="flex-1 min-h-0">
          <HtmlPreviewFrame filePath={artefact.page} reloadKey={reloadKey} />
        </div>
      )}
    </div>
  )
}
