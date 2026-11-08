import { useEffect, useRef } from 'react'
import { PageGuest, type PageGuestHandle } from '../layout/PageGuest'
import { usePreviewUrl } from '../../hooks/use-preview-url'
import { useFileChanged } from '../../hooks/use-file-changed'

/**
 * An .html file opened as a page — the file tab's and the preview panel's
 * rendered mode. A web-view guest (PageGuest) served through the clave-preview
 * protocol, so the page has a trail like any view: its links to the same
 * folder or to the local machine open in place, the wider web leaves for the
 * browser. The file is watched: a save from an editor or an agent reloads the
 * page where it is, and `reloadKey` is the header's Reload button.
 *
 * Not to be confused with HtmlPreviewFrame, the inert iframe the linked
 * document panel keeps beside its source editor.
 */
export function HtmlPage({
  filePath,
  reloadKey
}: {
  /** Absolute path of the .html file. */
  filePath: string
  /** Bump to reload the page the reader is on. */
  reloadKey?: number
}): React.JSX.Element {
  const { url, error } = usePreviewUrl(filePath)
  const guest = useRef<PageGuestHandle | null>(null)

  useFileChanged(filePath, () => guest.current?.reload())

  // Skip the mount value: the guest loads once by itself.
  const lastReload = useRef(reloadKey)
  useEffect(() => {
    if (reloadKey === lastReload.current) return
    lastReload.current = reloadKey
    guest.current?.reload()
  }, [reloadKey])

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
  return <PageGuest ref={guest} src={url} title={filePath.split('/').pop() ?? 'HTML page'} />
}
