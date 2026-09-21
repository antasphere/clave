import type { Session } from '../../../shared/session-model'
import type { PluginRecord } from '../../../main/plugins/plugin-store'

/** One view a session may be read in, as the picker lists it. `kind` says who
 *  renders it: `native` is code compiled into the renderer, `surface` is the
 *  plugin's own page in a sandboxed frame. */
export interface AvailableView {
  id: string
  title: string
  pluginName: string
  kind: 'native' | 'surface'
}
/** A NATIVE view is the host's own code, so the bar is the one wave 2 set for
 *  the single view there was: bundled with the app, enabled, running, granted
 *  both session permissions. A plugin the user linked cannot ship code into the
 *  renderer. */
function eligibleNative(plugin: PluginRecord): boolean {
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
/** A SURFACE view is the plugin's own page in a sandboxed frame with no origin
 *  of its own, reading the session through a lease main can revoke. That is why
 *  a linked plugin may contribute one where it may not contribute native code.
 *  Reading is the bar to be LISTED; writing is checked again in main, per call,
 *  against the grants as they stand then. */
function eligibleSurface(plugin: PluginRecord): boolean {
  return (
    plugin.enabled &&
    plugin.status === 'active' &&
    !plugin.error &&
    plugin.permissionsGranted.includes('sessions.read') &&
    plugin.manifest?.ui === 'surface' &&
    !!plugin.manifest.uiEntry
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
  return plugins.flatMap((plugin) => {
    const kind = eligibleNative(plugin) ? 'native' : eligibleSurface(plugin) ? 'surface' : null
    if (!kind) return []
    return (plugin.manifest?.contributes.views ?? [])
      .filter(
        (view) =>
          view.renders.includes(session.transport) &&
          // A native view exists only if this build carries its component; a
          // surface view is the plugin's own page, so the plugin is enough.
          (kind === 'surface' || implemented.has(`${plugin.id}/${view.id}`))
      )
      .map((view) => ({
        id: `${plugin.id}/${view.id}`,
        title: view.title ?? view.id,
        pluginName: plugin.manifest?.name ?? plugin.id,
        kind
      }))
  })
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
