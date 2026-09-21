import { useEffect, useState } from 'react'
import { PluginSurface } from './PluginSurface'

/** Mount a plugin panel: ask the main process for the panel's preview URL (which registers
 *  it with its CSP and hands back a URL revoked the moment the plugin stops), then render
 *  it in a PluginSurface. The URL is fetched per mount rather than held in the store: a
 *  plugin that restarted between two openings has a new generation and a new URL, and a
 *  stale one answers 404. */
export function PluginPanelHost({
  pluginId,
  panelId,
  title,
  generation
}: {
  pluginId: string
  panelId: string
  title: string
  generation: number
}): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    // No reset here: every host keys this component on pluginId:panelId:generation, so a
    // different panel is a different component rather than this one changing its mind.
    window.electronAPI
      .pluginsPanel(pluginId, panelId)
      .then((result) => {
        if (mounted) setUrl(result.url)
      })
      .catch((error: unknown) => {
        if (mounted) setError(String(error))
      })
    return () => {
      mounted = false
    }
  }, [pluginId, panelId, generation])
  if (error)
    return (
      <div className="flex-1 flex items-center justify-center px-3">
        <span className="text-xs text-text-tertiary text-center">{error}</span>
      </div>
    )
  if (!url) return <div className="flex-1" />
  // The key is belt and braces here and says so: this component fetches its url once per
  // mount and every host keys the component itself on pluginId:panelId:generation, so the
  // url never changes under a mounted host. It earns its keep at the settings page's call
  // site, where the same element is pointed at one panel's url after another.
  return <PluginSurface key={url} url={url} title={title} />
}
