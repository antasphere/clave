import type { PluginActionTarget, PluginActionTargetKind } from '@clave/plugin-sdk'
import type { PluginRecord } from '../../../../../../../packages/host/src/plugins/plugin-store'

/** An action, resolved against the record that registered it: the manifest says what it
 *  looks like and where it applies, the record says whether the running plugin claimed it. */
export interface PluginActionEntry {
  pluginId: string
  pluginName: string
  id: string
  title: string
  icon: string
  targets: PluginActionTargetKind[]
  preview: boolean
}

/** The live actions that apply to one kind of target, in record order then manifest order.
 *  Live means the plugin is switched on and running, declares the action, and registered it:
 *  a declared action nobody handles would be a menu entry that does nothing. */
export function pluginActions(
  records: PluginRecord[],
  kind: PluginActionTargetKind
): PluginActionEntry[] {
  return records
    .filter((record) => record.enabled && record.status === 'active' && !!record.manifest)
    .flatMap((record) =>
      (record.manifest?.contributes.actions ?? [])
        .filter((action) => action.targets.includes(kind) && record.actions.includes(action.id))
        .map((action) => ({
          pluginId: record.id,
          pluginName: record.manifest?.name ?? record.id,
          id: action.id,
          title: action.title,
          icon: action.icon,
          targets: action.targets,
          preview: action.preview === true
        }))
    )
}

/** Each entry's menu label, keyed `pluginId:id`. The context menu keys its items by label,
 *  so two plugins offering the same title are told apart by the plugin's name. */
export function actionLabels(entries: PluginActionEntry[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.title, (counts.get(entry.title) ?? 0) + 1)
  return new Map(
    entries.map((entry) => [
      actionKey(entry),
      (counts.get(entry.title) ?? 0) > 1 ? `${entry.title} · ${entry.pluginName}` : entry.title
    ])
  )
}

export const actionKey = (entry: Pick<PluginActionEntry, 'pluginId' | 'id'>): string =>
  `${entry.pluginId}:${entry.id}`

/** The workspace an action targets has no id of its own when none is open: `none`. */
export function workspaceTarget(activeWorkspaceId: string | null): PluginActionTarget {
  return { kind: 'workspace', id: activeWorkspaceId ?? 'none', workspaceId: activeWorkspaceId }
}

export function sessionTarget(id: string, activeWorkspaceId: string | null): PluginActionTarget {
  return { kind: 'session', id, workspaceId: activeWorkspaceId }
}

export function groupTarget(id: string, activeWorkspaceId: string | null): PluginActionTarget {
  return { kind: 'group', id, workspaceId: activeWorkspaceId }
}
