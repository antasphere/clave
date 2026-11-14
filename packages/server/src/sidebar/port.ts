/**
 * The sidebar's port on the server, in lane A's pattern (`../ports.ts`): the
 * `SidebarLayouts` instance the entry built over its storage and its windows,
 * as a service. `none` is a server with no entry behind it: layouts kept in
 * memory for the life of the process, no window to host, so a move between
 * windows answers `CapabilityUnavailable`.
 */
import { Context, Layer } from 'effect'
import { SidebarLayouts } from './layouts'
import type { SidebarOverviewSource } from './overview'
import { memorySidebarStorage, noWindowsHost } from './ports'

export class SidebarLayoutsPort extends Context.Tag('@clave/server/SidebarLayouts')<
  SidebarLayoutsPort,
  SidebarLayouts
>() {
  static layer(instance: SidebarLayouts): Layer.Layer<SidebarLayoutsPort> {
    return Layer.succeed(SidebarLayoutsPort, instance)
  }
  static get none(): SidebarLayouts {
    return new SidebarLayouts(memorySidebarStorage(), noWindowsHost)
  }
}

/**
 * Where the overview a phone reads comes from (`./overview.ts`): by default
 * the layouts of the port above, or what the entry names instead, the app's
 * own layout files for a server run as the app's child.
 */
export class SidebarOverviewPort extends Context.Tag('@clave/server/SidebarOverview')<
  SidebarOverviewPort,
  SidebarOverviewSource
>() {
  static layer(source: SidebarOverviewSource): Layer.Layer<SidebarOverviewPort> {
    return Layer.succeed(SidebarOverviewPort, source)
  }
}
