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
import { RequestsPort, type RequestsService } from './requests/port'
import { FilesPort, type FilesService } from './files/port'
export { FilesPort, type FilesService } from './files/port'
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
import { AgentTokens, type AgentTokensService } from './agent-tools/port'

export { AgentTokens, type AgentTokensService } from './agent-tools/port'
// ── Wave 5, lane C: the plugins ──
import { Plugins, type PluginsService } from './plugins/port'

export { Plugins, type PluginsService } from './plugins/port'
// ── Wave wcs1023, lane C: the git domain ──
import { GitPort, type GitService } from './git/port'

export { GitPort, type GitService } from './git/port'
// ── Issue #266: the server's version and its self-upgrade ──
import { ServerInfoPort, type ServerInfoService } from './server-info/port'

export { ServerInfoPort, type ServerInfoService } from './server-info/port'

export interface ServerPorts {
  readonly requests?: RequestsService
  readonly files?: FilesService
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
  /** Wave 4, lane C: who writes a Claude session's agent tool config and keeps
   *  its tokens. `AgentTokens.none` when absent: nothing minted, nothing resolved. */
  readonly agentTools?: AgentTokensService
  // ── Wave 5, lane C: the plugins ──
  /** Wave 5, lane C: the installed plugins, their host and the view leases. `Plugins.none` when absent: nothing installed, every call refused as unavailable. */
  readonly plugins?: PluginsService
  // ── Wave wcs1023, lane C: the git domain ──
  /** The checkouts on this server's disk, through the app's own git implementation. `GitPort.none` when absent: every call refused as unavailable. */
  readonly git?: GitService
  // ── Issue #266: the server domain ──
  /** The version this server runs and its self-upgrade. `ServerInfoPort.none` when absent: no version reported, no upgrade. */
  readonly serverInfo?: ServerInfoService
}

/** Every port as a layer, the domain's `none` where the entry gave nothing. */
export const PortsLive = (
  ports: ServerPorts
): Layer.Layer<
  | FilesPort
  | RequestsPort
  | SessionHost
  | SettingsSource
  | Terminals
  | SidebarLayoutsPort
  | WorkspaceFilesPort
  | AgentTokens
  // ── Wave 5, lane C: the plugins ──
  | Plugins
  // ── Wave wcs1023, lane C: the git domain ──
  | GitPort
  // ── Issue #266: the server domain ──
  | ServerInfoPort
> =>
  Layer.mergeAll(
    RequestsPort.layer(ports.requests ?? RequestsPort.none),
    FilesPort.layer(ports.files ?? FilesPort.none),
    SessionHost.layer(ports.sessions ?? SessionHost.none),
    SettingsSource.layer(ports.settings ?? SettingsSource.none),
    Terminals.layer(ports.terminals ?? Terminals.none),
    SidebarLayoutsPort.layer(ports.sidebar ?? SidebarLayoutsPort.none),
    WorkspaceFilesPort.layer(ports.workspaceFiles ?? WorkspaceFilesPort.none),
    // ── Wave 4, lane C: the agent tools' tokens ──
    AgentTokens.layer(ports.agentTools ?? AgentTokens.none),
    // ── Wave 5, lane C: the plugins ──
    Plugins.layer(ports.plugins ?? Plugins.none),
    // ── Wave wcs1023, lane C: the git domain ──
    GitPort.layer(ports.git ?? GitPort.none),
    // ── Issue #266: the server domain ──
    ServerInfoPort.layer(ports.serverInfo ?? ServerInfoPort.none)
  )
