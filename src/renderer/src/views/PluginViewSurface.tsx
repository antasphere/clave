import { useEffect, useRef, useState } from 'react'
import type { AgentState, Session, SessionEvent } from '../../../shared/session-model'

/** What a guest page may send up, and what the host sends down. The wire is
 *  deliberately tiny: a guest asks, the host answers, and events arrive. */
interface GuestRequest {
  clave: 'request'
  id: number | string
  method: string
  params?: unknown
}
const isGuestRequest = (value: unknown): value is GuestRequest =>
  typeof value === 'object' &&
  value !== null &&
  (value as { clave?: unknown }).clave === 'request' &&
  typeof (value as { method?: unknown }).method === 'string'

/** Enumerate the app's computed custom properties so the guest can paint with
 *  the live theme. Same approach as the panel surface's injection, expressed as
 *  a message because a sandboxed frame has no origin to inject into. */
function themeCSS(): string {
  const style = getComputedStyle(document.documentElement)
  return `:root {${Array.from(style)
    .filter((name) => name.startsWith('--'))
    .map((name) => `${name}: ${style.getPropertyValue(name)};`)
    .join('\n')}}`
}

/** A plugin's own page, rendering one session, in a frame with no origin and no
 *  preload.
 *
 *  The guest cannot reach the app: `sandbox` is `allow-scripts` and NEVER
 *  `allow-same-origin`, so the frame is opaque-origin — no access to the parent
 *  document, no `window.electronAPI`, no storage of the app's. Its only channel
 *  is `postMessage` to this component, which accepts a message solely when
 *  `event.source` is this frame's own window, and relays it to main naming the
 *  LEASE, never a session. Main fixes the session at the lease's birth and
 *  re-checks the plugin's grants on every call, so what the guest may do is
 *  decided where the guest cannot reach.
 *
 *  This is the same shape as the view bridge of PR #58, and it can be unified
 *  with `components/plugins/PluginSurface.tsx` (the panel host, a preload-free
 *  webview) once the wave has landed. */
export function PluginViewSurface({
  pluginId,
  viewId,
  session,
  onState
}: {
  pluginId: string
  viewId: string
  session: Session
  onState: (state: AgentState, model: string | null) => void
}): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const [lease, setLease] = useState<{ leaseId: string; url: string } | null>(null)
  const [failure, setFailure] = useState('')
  const sessionId = session.id

  // One lease per (plugin view, session), taken on mount and revoked on the way
  // out: a pane that is gone holds no authority over a session. The host mounts
  // this component under a key of the three, so a change of any of them is a
  // fresh component rather than a state reset inside this effect.
  useEffect(() => {
    let live = true
    let taken: string | null = null
    void window.electronAPI
      .pluginsViewLease(pluginId, viewId, sessionId)
      .then((granted) => {
        taken = granted.leaseId
        if (live) setLease({ leaseId: granted.leaseId, url: granted.url })
        else void window.electronAPI.pluginsViewRevoke(granted.leaseId)
      })
      .catch((error: unknown) => {
        if (live) setFailure(String(error))
      })
    return () => {
      live = false
      if (taken) void window.electronAPI.pluginsViewRevoke(taken)
    }
  }, [pluginId, viewId, sessionId])

  // The guest's only channel, and the session's events on their way down.
  useEffect(() => {
    if (!lease) return
    const post = (message: unknown): void =>
      // The frame is opaque-origin, so '*' is the only target that reaches it;
      // it is this component's own frame and the payload is this session's.
      frame.current?.contentWindow?.postMessage(message, '*')
    const onMessage = (event: MessageEvent): void => {
      // Identity, not origin: an opaque-origin frame reports "null", which any
      // other sandboxed frame would report too.
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const message: unknown = event.data
      if ((message as { clave?: unknown } | null)?.clave === 'hello') {
        post({ clave: 'init', sessionId, theme: themeCSS() })
        return
      }
      if (!isGuestRequest(message)) return
      void window.electronAPI
        .pluginsViewRequest(lease.leaseId, message.method, message.params)
        .then((result) => post({ clave: 'response', id: message.id, result }))
        .catch((error: unknown) =>
          post({ clave: 'response', id: message.id, error: String(error) })
        )
    }
    window.addEventListener('message', onMessage)
    const stop = window.electronAPI.onPluginViewEvent(lease.leaseId, (event: SessionEvent) => {
      post({ clave: 'event', event })
      // The pane's header follows the view's session like any other view's.
      if (event.type === 'state_change') onState(event.state, null)
    })
    return () => {
      window.removeEventListener('message', onMessage)
      stop()
    }
  }, [lease, sessionId, onState])

  // Re-send the theme when the app's changes, the way the panel surface does.
  useEffect(() => {
    if (!lease) return
    const observer = new MutationObserver(() =>
      frame.current?.contentWindow?.postMessage({ clave: 'theme', theme: themeCSS() }, '*')
    )
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style', 'class']
    })
    return () => observer.disconnect()
  }, [lease])

  if (failure)
    return (
      <div className="chat-empty">
        <h2>This view could not open</h2>
        <p>{failure}</p>
      </div>
    )
  if (!lease) return <div className="chat-empty" aria-busy="true" />
  return (
    <iframe
      ref={frame}
      key={lease.url}
      src={lease.url}
      title={`${pluginId} view`}
      // allow-same-origin is never granted: it is what keeps the guest out of
      // the app's document, storage and bridge.
      sandbox="allow-scripts"
      className="flex flex-1 w-full h-full min-h-0"
    />
  )
}
