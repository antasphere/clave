import { useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { SettingsCallout } from '../settings/primitives'

/** Enumerate the computed custom properties, including tokens introduced by a skin.
 * No mirrored token inventory: the live app stylesheet is the authority. */
function themeCSS(): string {
  const style = getComputedStyle(document.documentElement)
  return `:root {${Array.from(style)
    .filter((name) => name.startsWith('--'))
    .map((name) => `${name}: ${style.getPropertyValue(name)};`)
    .join('\n')}}`
}

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
    let disposed = false
    let cssKey: string | undefined
    let ready = false
    let queue = Promise.resolve()
    const inject = (): void => {
      queue = queue
        .then(async () => {
          if (!ready || disposed) return
          const next = await guest.insertCSS(themeCSS())
          if (cssKey) await guest.removeInsertedCSS(cssKey)
          cssKey = next
        })
        .catch((error) => {
          if (!disposed) setError(String(error))
        })
    }
    const loaded = (): void => {
      ready = true
      inject()
    }
    const failed = (event: Event): void => {
      setError((event as Event & { errorDescription: string }).errorDescription)
    }
    guest.addEventListener('dom-ready', loaded)
    guest.addEventListener('did-fail-load', failed)
    const observer = new MutationObserver(inject)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style', 'class']
    })
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    })
    return () => {
      disposed = true
      observer.disconnect()
      guest.removeEventListener('dom-ready', loaded)
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
