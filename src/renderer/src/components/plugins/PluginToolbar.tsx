import { useState } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from '@clave/ui/components'
import { PluginIcon } from './plugin-icon'
import {
  usePluginRecords,
  pluginPanels,
  pluginToolbarEntries,
  usePluginUIStore,
  type PluginToolbarEntry,
  type PluginPanelEntry
} from './plugin-ui-store'
import { cn } from '@clave/ui/components'

/** Toolbar contributions, in the right-hand cluster beside the side-panel toggle. An action
 *  is one button running the plugin's command of the same id; a popover is a button opening
 *  the menu surface, each item running its own command. Both go through `plugins:command`,
 *  the one path the host already guards — a toolbar entry buys no new way to execute. */
export function PluginToolbar(): React.JSX.Element | null {
  const records = usePluginRecords()
  const entries = pluginToolbarEntries(records)
  // A `placement: 'main'` panel is a place, and places are opened from this cluster — the
  // file tree beside it works the same way. The toolbar is its opener until the pane kernel
  // can carry a plugin as a tile of the mosaic.
  const mainPanels = pluginPanels(records, 'main')
  if (entries.length === 0 && mainPanels.length === 0) return null
  return (
    <>
      {entries.map((entry) =>
        entry.kind === 'popover' ? (
          <PluginToolbarPopover key={`${entry.pluginId}:${entry.id}`} entry={entry} />
        ) : (
          <button
            key={`${entry.pluginId}:${entry.id}`}
            className="btn-icon btn-icon-md flex-shrink-0"
            title={`${entry.title} (${entry.pluginName})`}
            data-plugin-toolbar={entry.id}
            onClick={() => void run(entry.pluginId, entry.id)}
          >
            <PluginIcon name={entry.icon} />
          </button>
        )
      )}
      {mainPanels.map((panel) => (
        <PluginMainPanelButton key={`${panel.pluginId}:${panel.panelId}`} panel={panel} />
      ))}
    </>
  )
}

function PluginMainPanelButton({ panel }: { panel: PluginPanelEntry }): React.JSX.Element {
  const open = usePluginUIStore((s) => s.mainPanel)
  const openMainPanel = usePluginUIStore((s) => s.openMainPanel)
  const shown = open?.pluginId === panel.pluginId && open?.panelId === panel.panelId
  return (
    <button
      className={cn('btn-icon btn-icon-md flex-shrink-0', shown && '!text-accent')}
      title={`${panel.title} (${panel.pluginName})`}
      data-plugin-main-toggle={panel.panelId}
      onClick={() =>
        openMainPanel(shown ? null : { pluginId: panel.pluginId, panelId: panel.panelId })
      }
    >
      <PluginIcon name={panel.icon} />
    </button>
  )
}

function PluginToolbarPopover({ entry }: { entry: PluginToolbarEntry }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="btn-icon btn-icon-md flex-shrink-0"
          title={`${entry.title} (${entry.pluginName})`}
          data-plugin-toolbar={entry.id}
        >
          <PluginIcon name={entry.icon} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        animated
        open={open}
        side="bottom"
        align="end"
        sideOffset={8}
        className="min-w-[180px] p-1"
        data-plugin-toolbar-menu={entry.id}
      >
        {entry.items.map((item) => (
          <button
            key={item.id}
            className="menu-item w-full"
            data-plugin-toolbar-item={item.id}
            onClick={() => {
              setOpen(false)
              void run(entry.pluginId, item.id)
            }}
          >
            {item.title}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** A command the plugin refuses (it stopped, it never registered the id) is the plugin's
 *  own business: Settings shows its error, and the toolbar stays silent rather than
 *  throwing an unhandled rejection into the renderer. */
async function run(pluginId: string, commandId: string): Promise<void> {
  try {
    await window.electronAPI.pluginsCommand(pluginId, commandId)
  } catch (error) {
    console.error(`[plugins] ${pluginId}: ${String(error)}`)
  }
}
