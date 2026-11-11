import { useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../../store/session-store'
import { initSlideless, useSlidelessStore } from '../../store/slideless-store'
import { finishesTurn } from '../../lib/tab-status'
import { HtmlPreviewFrame } from './HtmlPreviewFrame'

/** How many times a minute a view serves again a server that died under it. */
const RESTART_LIMIT = 3

/**
 * An HTML artefact shown through Slideless (PRDCT-4262): main runs the
 * Slideless command line Clave installed (`slideless dev` on the folder, or on
 * the one page), and the panel frames its local page, the deck under a version
 * bar that reloads on every edit. Each time the session that opened it ends a
 * turn, a version is saved: one iteration of the agent, one version, nothing
 * asked of the agent. Without a usable command line the page is still shown,
 * as before, under a card that installs it.
 */
export function SlidelessArtefact({
  target,
  page,
  sessionId,
  reloadKey
}: {
  /** What Slideless serves and keeps versions of: the folder, or the one page. */
  target: string
  /** The page to show when Slideless is not there. */
  page: string
  sessionId: string
  /** Bumped when the page changed on disk, for the fallback preview. */
  reloadKey?: number
}): React.JSX.Element {
  useEffect(() => initSlideless(), [])
  const slideless = useSlidelessStore((s) => s.state)
  const install = useSlidelessStore((s) => s.install)
  const ready = slideless?.phase === 'ready'
  const [served, setServed] = useState<{ target: string; url?: string; error?: string } | null>(
    null
  )
  // Bumped when main reports this target's server gone: the effect serves
  // again, at most RESTART_LIMIT times a minute, so a server that keeps dying
  // ends with its error on screen rather than a loop.
  const [generation, setGeneration] = useState(0)
  const restarts = useRef<number[]>([])
  useEffect(
    () =>
      window.electronAPI.slideless.onServerExited((exited) => {
        if (exited !== target) return
        const now = Date.now()
        restarts.current = restarts.current.filter((t) => now - t < 60_000)
        if (restarts.current.length >= RESTART_LIMIT) {
          setServed({
            target,
            error: 'Slideless stopped again and again; reopen the panel to retry'
          })
          return
        }
        restarts.current.push(now)
        setGeneration((g) => g + 1)
      }),
    [target]
  )

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    let lease: string | null = null
    window.electronAPI.slideless
      .serve(target)
      .then((served) => {
        lease = served.lease
        if (cancelled) void window.electronAPI.slideless.release(target, served.lease)
        else setServed({ target, url: served.url })
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setServed({ target, error: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
      // The lease names the server this view holds: after a crash it is the
      // old one, and releasing it leaves another view's new server alone.
      if (lease) void window.electronAPI.slideless.release(target, lease)
    }
  }, [ready, target, generation])

  // One version per finished turn of the session that holds the artefact.
  const agentState = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.agentState)
  const previous = useRef(agentState)
  const url = served?.target === target ? served.url : undefined
  useEffect(() => {
    const was = previous.current
    previous.current = agentState
    if (!url || !finishesTurn(was, agentState)) return
    window.electronAPI.slideless.snapshot(target).catch((err: unknown) => {
      console.warn('[slideless] the turn-end version was not saved:', err)
    })
  }, [agentState, target, url])

  if (ready && url)
    return (
      <iframe
        key={url}
        src={url}
        data-testid="slideless-artefact"
        // The local page runs on its own loopback origin, never the app's;
        // its deck sits in a sandboxed frame of its own inside it.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
        referrerPolicy="no-referrer"
        className="w-full h-full border-0 bg-white"
        title={page.split('/').pop() ?? 'Artefact'}
      />
    )

  const serveError = ready && served?.target === target ? served.error : undefined
  const phase = slideless?.phase
  return (
    <div className="flex flex-col h-full">
      {phase && phase !== 'ready' && (
        <div className="linked-document-notice" data-testid="slideless-install-card">
          <span className="flex-1 min-w-0">
            {phase === 'installing'
              ? 'Installing Slideless: this page will reload on every edit and keep a version each turn.'
              : phase === 'error'
                ? `Slideless could not be installed: ${slideless?.error ?? 'unknown error'}`
                : 'Install Slideless to reload this page on every edit and keep a version each turn.'}
          </span>
          {phase !== 'installing' && (
            <button className="btn-primary btn-compact" onClick={() => void install()}>
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
      <div className="flex-1 min-h-0">
        <HtmlPreviewFrame filePath={page} reloadKey={reloadKey} />
      </div>
    </div>
  )
}
