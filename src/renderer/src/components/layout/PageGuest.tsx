import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import type { WebviewTag } from 'electron'

/** Mirrors VIEW_PARTITION in src/main/view-guests.ts, where the session's
 *  permission handlers and the preview protocol live; the renderer cannot
 *  import the main process. */
export const VIEW_PARTITION = 'persist:view'

/** Where the guest is, read off the web view after every navigation. */
export interface PageTrail {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
}

export interface PageGuestHandle {
  back: () => void
  forward: () => void
  /** Loads `src` again as a new entry: home from any depth. */
  home: () => void
  /** Reloads the page the reader is ON; the trail survives. */
  reload: () => void
}

/**
 * A page the reader browses, as an Electron web view: a guest with a history
 * of its own. It is what every view (a group's, a session's) and every .html
 * file opened as a page renders into — one frame, one trail, one link rule.
 *
 * The guest is hardened in the main process (no preload, no node, sandboxed,
 * every permission refused) and its links are policed there (view-guests.ts):
 * the local machine, the page's own origin or its own folder stay in the pane,
 * the wider web opens in the system browser. `allowpopups` is what lets a
 * popup REACH that policy: without it Chromium drops window.open and every
 * target="_blank" link on the floor before any handler runs — and the exos
 * pages open their tasks that way. With it, the guest's window-open handler
 * denies the window and hands the url to the system browser.
 *
 * The parent owns the trail state (`onTrail`) and drives the guest through the
 * handle; remounting is the parent's business too (a `key`), since a new
 * element is a new history. The tag's methods throw until the guest is
 * attached, and the element renders before that, so every call is guarded —
 * an unattached guest simply reads as "at home, nowhere to go".
 */
export const PageGuest = forwardRef<
  PageGuestHandle,
  {
    src: string
    title?: string
    onTrail?: (trail: PageTrail) => void
    /** The guest's first load has ended, well or badly: the page is painted
     *  (or its error is), so whatever was standing in for it can go. Once per
     *  mount; a later navigation is the page's own business. */
    onFirstLoad?: () => void
    className?: string
  }
>(function PageGuest({ src, title, onTrail, onFirstLoad, className }, ref) {
  const webviewRef = useRef<WebviewTag | null>(null)
  const onTrailRef = useRef(onTrail)
  useEffect(() => {
    onTrailRef.current = onTrail
  }, [onTrail])
  const onFirstLoadRef = useRef(onFirstLoad)
  useEffect(() => {
    onFirstLoadRef.current = onFirstLoad
  }, [onFirstLoad])

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    let loaded = false
    const firstLoad = (): void => {
      if (loaded) return
      loaded = true
      onFirstLoadRef.current?.()
    }
    for (const e of ['did-finish-load', 'did-fail-load']) wv.addEventListener(e, firstLoad)
    return () => {
      for (const e of ['did-finish-load', 'did-fail-load']) wv.removeEventListener(e, firstLoad)
    }
  }, [src])

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const sync = (): void => {
      try {
        onTrailRef.current?.({
          url: wv.getURL() || src,
          title: wv.getTitle(),
          canGoBack: wv.canGoBack(),
          canGoForward: wv.canGoForward()
        })
      } catch {
        // not attached yet — the next event will land
      }
    }
    const events = [
      'dom-ready',
      'did-navigate',
      'did-navigate-in-page',
      'did-finish-load',
      'page-title-updated'
    ]
    for (const e of events) wv.addEventListener(e, sync)
    return () => {
      for (const e of events) wv.removeEventListener(e, sync)
    }
  }, [src])

  const guest = useCallback((fn: (wv: WebviewTag) => void): void => {
    const wv = webviewRef.current
    if (!wv) return
    try {
      fn(wv)
    } catch {
      // not attached — nothing to drive
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      back: () => guest((wv) => wv.goBack()),
      forward: () => guest((wv) => wv.goForward()),
      home: () => guest((wv) => void wv.loadURL(src)),
      reload: () => guest((wv) => wv.reload())
    }),
    [guest, src]
  )

  return (
    <webview
      ref={webviewRef}
      src={src}
      // eslint-disable-next-line react/no-unknown-property -- Electron's own attribute
      partition={VIEW_PARTITION}
      // React does not know Electron's attribute and DROPS a boolean value
      // for an unknown one (typed boolean by @types/react, rendered by
      // nothing); the string is what reaches the element, and Electron
      // reads presence, not value.
      // eslint-disable-next-line react/no-unknown-property -- Electron's own attribute
      allowpopups={'true' as unknown as boolean}
      className={`w-full h-full bg-white ${className ?? ''}`}
      style={{ display: 'flex' }}
      title={title}
    />
  )
})
