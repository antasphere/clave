import { useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { SettingsCallout } from '../settings/primitives'
import { attachGuestTheme } from '../../lib/guest-theme'

/** The one host for a plugin's `ui: surface` HTML: the settings page, the side panel and the
 * tiled area all render a plugin through this component, so the CSP the main process attached
 * to the preview URL, the theme-variable injection and the revocable URL behave identically
 * wherever a surface appears. `url` comes from `pluginsPanel`. A caller that points one
 * element at a succession of panels — the settings page does — remounts it with `key={url}`,
 * so a revoked URL never survives in a live guest; a caller that mounts one surface per panel
 * already remounts on a key of its own. */
export function PluginSurface({
  url,
  title,
  className = 'flex flex-1 w-full h-full min-h-0'
}: {
  url: string
  title: string
  className?: string
}): React.JSX.Element {
  const ref = useRef<WebviewTag | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const guest = ref.current
    if (!guest) return
    const failed = (event: Event): void => {
      setError((event as Event & { errorDescription: string }).errorDescription)
    }
    guest.addEventListener('did-fail-load', failed)
    const detach = attachGuestTheme(guest, setError)
    return () => {
      detach()
      guest.removeEventListener('did-fail-load', failed)
    }
  }, [url])
  return (
    <>
      {error && <SettingsCallout tone="danger" text={error} />}
      <webview
        ref={ref}
        src={url}
        title={title}
        // eslint-disable-next-line react/no-unknown-property -- Electron webview attribute
        partition="persist:view"
        className={className}
      />
    </>
  )
}
