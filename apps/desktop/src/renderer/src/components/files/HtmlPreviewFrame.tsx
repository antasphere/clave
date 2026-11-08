import { useEffect, useState } from 'react'

/**
 * Renders a local HTML file inside a sandboxed, inert iframe: the linked
 * document panel's preview beside its source editor. Not a page the reader
 * browses — that is HtmlPage (the file tab, the preview panel) and the views,
 * on a web-view guest with a trail. This one has no history, follows no link
 * the app would want to know about, and reloads by revision.
 *
 * The file is served over the clave-preview protocol (main process), which
 * scopes requests to the file's own directory — sibling CSS/JS/images load,
 * anything outside the folder 404s. The sandbox runs scripts under an opaque
 * origin with no same-origin grant: the page can never reach the preload
 * bridge, the app's DOM, or navigate the app away. Link clicks that try to
 * open windows are routed to the system browser by main's window-open handler.
 */
export function HtmlPreviewFrame({
  filePath,
  className,
  reloadKey
}: {
  /** Absolute path of the .html file. */
  filePath: string
  className?: string
  /** Bump to force a fresh load of the page. */
  reloadKey?: number
}): React.JSX.Element {
  // Keyed by path so a file switch renders "Loading…" without a reset write.
  const [result, setResult] = useState<{ forPath: string; url?: string; error?: string } | null>(
    null
  )

  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .registerHtmlPreview(filePath)
      .then(({ url }) => {
        if (!cancelled) setResult({ forPath: filePath, url })
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setResult({ forPath: filePath, error: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [filePath])

  const current = result?.forPath === filePath ? result : null
  const url = current?.url ?? null
  const error = current?.error ?? null

  if (error) {
    return (
      <div className="px-4 py-8 text-center text-sm text-text-tertiary">
        Failed to render page
        <div className="mt-1 text-xs">{error}</div>
      </div>
    )
  }

  if (!url) {
    return <div className="px-4 py-8 text-center text-sm text-text-tertiary">Loading…</div>
  }

  return (
    <iframe
      key={`${url}#${reloadKey ?? 0}`}
      src={url}
      sandbox="allow-scripts"
      className={`w-full h-full border-0 bg-white ${className ?? ''}`}
      title={filePath.split('/').pop() ?? 'HTML preview'}
    />
  )
}
