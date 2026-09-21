import type { Session } from '../../../shared/session-model'
import type { PluginRecord } from '../../../main/plugins/plugin-store'

/** One view a session may be read in, as the picker lists it. */
export interface AvailableView {
  id: string
  title: string
  pluginName: string
}
/** A plugin may contribute a view only while it is the host's own bundled code,
 *  enabled, running, and granted both session permissions — the same bar wave 2
 *  set for mounting the one view there was. */
function eligible(plugin: PluginRecord): boolean {
  return (
    plugin.source === 'bundled' &&
    plugin.enabled &&
    plugin.status === 'active' &&
    !plugin.error &&
    plugin.permissionsGranted.includes('sessions.read') &&
    plugin.permissionsGranted.includes('sessions.write') &&
    plugin.manifest?.ui === 'native'
  )
}
/** Every view that can render this session, in manifest order: what the picker
 *  offers and what resolution falls back through. `implemented` says which
 *  `<pluginId>/<viewId>` the host can actually mount, so a manifest that
 *  declares a view the build does not carry never reaches a pane. */
export function availableViews(
  session: Session | undefined,
  plugins: PluginRecord[],
  implemented: ReadonlySet<string>
): AvailableView[] {
  if (!session || session.transport !== 'events') return []
  return plugins.filter(eligible).flatMap((plugin) =>
    (plugin.manifest?.contributes.views ?? [])
      .filter(
        (view) =>
          view.renders.includes(session.transport) && implemented.has(`${plugin.id}/${view.id}`)
      )
      .map((view) => ({
        id: `${plugin.id}/${view.id}`,
        title: view.title ?? view.id,
        pluginName: plugin.manifest?.name ?? plugin.id
      }))
  )
}
/** Which view this session is read in. The session's own choice wins; a choice
 *  whose plugin is gone, disabled or no longer contributing that view falls back
 *  to the first view that renders the transport, and no view at all returns
 *  undefined, which the host reads as the terminal. Resolution never fails, so
 *  disabling a plugin can never strand a session on a dead view. */
export function resolveView(
  session: Session | undefined,
  plugins: PluginRecord[],
  implemented: ReadonlySet<string>
): string | undefined {
  const views = availableViews(session, plugins, implemented)
  if (!views.length) return undefined
  return views.find((view) => view.id === session?.viewId)?.id ?? views[0].id
}
