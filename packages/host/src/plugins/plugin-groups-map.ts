/**
 * A window's sidebar layout as the plugins read its groups: each group's id,
 * name, members and workspace, nothing of its terminals, views or order. Pure,
 * and free of Electron, so it is tested on its own (`plugin-groups.ts` is the
 * shell's reporter around it).
 */
import type { PluginGroup } from '@clave/contract/plugins'
import type { LayoutSnapshot } from '@clave/contract/sidebar/layout'

export function pluginGroupsOf(snapshot: LayoutSnapshot): PluginGroup[] {
  return snapshot.groups.map((group) => ({
    id: group.id,
    name: group.name,
    sessionIds: [...group.sessionIds],
    workspaceId: group.workspaceId ?? null
  }))
}
