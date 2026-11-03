import type { PluginActionTarget } from '@clave/plugin-sdk'
import type { ContextMenuItem } from '../ui/ContextMenu'
import { useWorkspaceStore } from '../../store/workspace-store'
import { PluginIcon } from './plugin-icon'
import { PluginActionPreview } from './PluginActionPreview'
import { usePluginUIStore } from './plugin-ui-store'
import {
  actionKey,
  actionLabels,
  groupTarget,
  pluginActions,
  sessionTarget,
  type PluginActionEntry
} from './plugin-actions-model'

/** Run an action and open the page it answers in the content column. A refusal (the plugin
 *  stopped, the handler threw) is the plugin's own business, as for a toolbar command:
 *  logged, never thrown into the renderer. */
export async function runPluginAction(
  entry: PluginActionEntry,
  target: PluginActionTarget
): Promise<void> {
  try {
    const result = await window.electronAPI.pluginsInvokeAction(entry.pluginId, entry.id, target)
    const page = result?.page
    if (!page) return
    usePluginUIStore.getState().openPage({
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      icon: entry.icon,
      title: page.title,
      url: page.url
    })
  } catch (error) {
    console.error(`[plugins] ${entry.pluginId}: ${String(error)}`)
  }
}

/** The plugin entries of a tab's or a group's right-click menu, read at the moment the menu
 *  opens. Empty when no running plugin offers an action on that kind of target. */
export function pluginActionMenuItems(kind: 'session' | 'group', id: string): ContextMenuItem[] {
  const records = usePluginUIStore.getState().records
  const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId
  const entries = pluginActions(records, kind)
  const labels = actionLabels(entries)
  return entries.map((entry) => {
    const target =
      kind === 'session' ? sessionTarget(id, activeWorkspaceId) : groupTarget(id, activeWorkspaceId)
    return {
      label: labels.get(actionKey(entry)) ?? entry.title,
      icon: <PluginIcon name={entry.icon} className="w-3.5 h-3.5" />,
      onClick: () => void runPluginAction(entry, target),
      preview: entry.preview ? <PluginActionPreview entry={entry} target={target} /> : undefined
    }
  })
}
