/**
 * The sidebar's port on the server, in lane A's pattern (`../ports.ts`): the
 * `SidebarLayouts` instance the entry built over its storage and its windows,
 * as a service. `none` is a server with no entry behind it: layouts kept in
 * memory for the life of the process, no window to host, so a move between
 * windows answers `CapabilityUnavailable`.
 */
import { Context, Layer } from 'effect'
import { SidebarLayouts } from './layouts'
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
