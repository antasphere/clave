/**
 * The ports, one per domain: what the server needs from whoever runs it.
 * Inside the app the shell implements each over the managers it already has
 * (`src/main/server/*`); a standalone entry gives the ones it can and the
 * domain's `none` for the rest, which answers `CapabilityUnavailable`.
 *
 * The pattern a lane follows: the port lives in its domain folder
 * (`<domain>/port.ts`, a `Context.Tag` with a `layer(service)` and a `none`),
 * is re-exported here, and gets one optional field in `ServerPorts`. The
 * composition root (`runtime.ts`) provides every port from this object.
 */
import { Layer } from 'effect'
import { SessionHost, type SessionHostService } from './sessions/port'
import { Terminals, type TerminalsService } from './terminals/port'

export type { StartInput, Unsubscribe } from './sessions/port'
export { SessionHost, type SessionHostService } from './sessions/port'
import { SettingsSource, type SettingsSourceService } from './settings/port'

export { SettingsSource, type SettingsSourceService } from './settings/port'
export { Terminals, type TerminalsService } from './terminals/port'
import { SidebarLayoutsPort } from './sidebar/port'
import type { SidebarLayouts } from './sidebar/layouts'

export { SidebarLayoutsPort } from './sidebar/port'
import { WorkspaceFilesPort } from './workspace-files/port'
import type { WorkspaceFiles } from './workspace-files/files'

export { WorkspaceFilesPort } from './workspace-files/port'

export interface ServerPorts {
  /** Lane A: the sessions. `SessionHost.none` when absent. */
  readonly sessions?: SessionHostService
  /** Lane D: the settings. `SettingsSource.none` when absent. */
  readonly settings?: SettingsSourceService
  /** Lane B: the terminals, where a session's process comes from.
   *  `Terminals.none` when absent. */
  readonly terminals?: TerminalsService
  /** Lane C: the sidebar, one layout per window key. `SidebarLayoutsPort.none`
   *  when absent: layouts kept in memory, no window to host. */
  readonly sidebar?: SidebarLayouts
  /** Wave 3, lane A: the workspace files (`.clave`), their trust store on the
   *  entry's data directory. `WorkspaceFilesPort.none` when absent: the
   *  trust store kept in memory. */
  readonly workspaceFiles?: WorkspaceFiles
}

/** Every port as a layer, the domain's `none` where the entry gave nothing. */
export const PortsLive = (
  ports: ServerPorts
): Layer.Layer<
  SessionHost | SettingsSource | Terminals | SidebarLayoutsPort | WorkspaceFilesPort
> =>
  Layer.mergeAll(
    SessionHost.layer(ports.sessions ?? SessionHost.none),
    SettingsSource.layer(ports.settings ?? SettingsSource.none),
    Terminals.layer(ports.terminals ?? Terminals.none),
    SidebarLayoutsPort.layer(ports.sidebar ?? SidebarLayoutsPort.none),
    WorkspaceFilesPort.layer(ports.workspaceFiles ?? WorkspaceFilesPort.none)
  )
