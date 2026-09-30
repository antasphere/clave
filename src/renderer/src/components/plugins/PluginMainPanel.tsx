import { XMarkIcon } from '@heroicons/react/24/outline'
import { PluginIcon } from './plugin-icon'
import { PluginPanelHost } from './PluginPanelHost'
import { usePluginRecords, pluginPanels, usePluginUIStore } from './plugin-ui-store'

/** A `placement: 'main'` panel, in the content column where Settings and the mosaic live.
 *  It is a full-area card rather than a tile of the mosaic: every tile there is a session
 *  today, and a plugin is not one. Promoting it to a real tile belongs to the pane kernel.
 *  Renders nothing when no main panel is open, and closes itself when the plugin that
 *  contributed it stops — a card left behind would show a revoked URL. */
export function PluginMainPanel(): React.JSX.Element | null {
  const selection = usePluginUIStore((s) => s.mainPanel)
  const close = usePluginUIStore((s) => s.openMainPanel)
  const panel =
    pluginPanels(usePluginRecords(), 'main').find(
      (entry) => entry.pluginId === selection?.pluginId && entry.panelId === selection?.panelId
    ) ?? null
  if (!panel) return null
  return (
    <div
      className="flex-1 min-h-0 floating-card flex flex-col"
      data-plugin-main-panel={panel.panelId}
    >
      <div className="flex items-center shrink-0 px-0.5">
        <span className="panel-tab" data-selected="true">
          <PluginIcon name={panel.icon} className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{panel.title}</span>
        </span>
        <button
          className="panel-icon-btn ml-auto"
          aria-label={`Close ${panel.title}`}
          onClick={() => close(null)}
        >
          <XMarkIcon className="w-4 h-4" />
        </button>
      </div>
      <PluginPanelHost
        key={`${panel.pluginId}:${panel.panelId}:${panel.generation}`}
        pluginId={panel.pluginId}
        panelId={panel.panelId}
        title={panel.title}
        generation={panel.generation}
      />
    </div>
  )
}
