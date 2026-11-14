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
import { SidebarLayoutsPort, SidebarOverviewPort } from './sidebar/port'
import type { SidebarLayouts } from './sidebar/layouts'
import { layoutsOverviewSource, type SidebarOverviewSource } from './sidebar/overview'

export { SidebarLayoutsPort, SidebarOverviewPort } from './sidebar/port'
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
// ── PRDCT-4321: the server's History ──
import { HistoryPort, type HistoryService } from './history/port'

export { HistoryPort, type HistoryService } from './history/port'
// ── ADR 0004: the routines ──
import { Routines, type RoutinesService } from './routines/port'

export { Routines, type RoutinesService } from './routines/port'
// ── PRDCT-4327: the digests ──
import { DigestsPort, type DigestsService } from './digests/port'

export { DigestsPort, type DigestsService } from './digests/port'
// ── Mobile wave, lane A: the devices ──
import { DevicesPort, type DevicesPortService } from './devices/port'

export { DevicesPort, type DevicesPortService } from './devices/port'
// ── The mobile wave, lane B: where the write ledger is kept (`sessions/writes.ts`) ──
import type { WriteLedgerStorage } from './sessions/writes'

export { type WriteLedgerStorage } from './sessions/writes'
// ── PRDCT-4411: the speech ──
import { SpeechPort, type SpeechService } from './speech/port'

export { SpeechPort, type SpeechService } from './speech/port'

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
  /** Where the overview a phone reads comes from (`sidebar/overview.ts`).
   *  The layouts of `sidebar` when absent; a server run as the app's child
   *  names the app's own layout files instead, since it holds none. */
  readonly sidebarOverview?: SidebarOverviewSource
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
  // ── PRDCT-4321: the server's History ──
  /** The conversations this server's tabs ran (PRDCT-4321). `HistoryPort.none` when absent: no History of its own. */
  readonly history?: HistoryService
  // ── ADR 0004: the routines ──
  /** The scheduler and its runs. `Routines.none` when absent: nothing listed, every act refused as unavailable. */
  readonly routines?: RoutinesService
  // ── PRDCT-4327: the digests ──
  /** The one-shot digests a chat view shows, read on the server's own record of each session. `DigestsPort.none` when absent: every call refused as unavailable. */
  readonly digests?: DigestsService
  // ── Mobile wave, lane A: the devices ──
  /** A phone paired with this server as its owner's: the device records'
   *  document, the owner's identity, the issuer, the server's name.
   *  `DevicesPort.none` when absent: no owner, so no phone is ever admitted. */
  readonly devices?: DevicesPortService
  // ── The mobile wave, lane B: nothing is sent twice ──
  /** Where the write ledger and the server's own history of writes are
   *  kept, per session (`sessions/writes.ts`); in memory when absent. */
  readonly writeLedger?: WriteLedgerStorage
  // ── PRDCT-4411: the speech ──
  /** Text spoken with the machine's ElevenLabs voice, for a session the server has a record of. `SpeechPort.none` when absent: every call refused as unavailable. */
  readonly speech?: SpeechService
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
  | SidebarOverviewPort
  | WorkspaceFilesPort
  | AgentTokens
  // ── Wave 5, lane C: the plugins ──
  | Plugins
  // ── Wave wcs1023, lane C: the git domain ──
  | GitPort
  // ── Issue #266: the server domain ──
  | ServerInfoPort
  // ── PRDCT-4321: the server's History ──
  | HistoryPort
  // ── ADR 0004: the routines ──
  | Routines
  // ── PRDCT-4327: the digests ──
  | DigestsPort
  // ── Mobile wave, lane A: the devices ──
  | DevicesPort
  // ── PRDCT-4411: the speech ──
  | SpeechPort
> => {
  // One instance for both ports: `none` is a getter that builds a new one.
  const sidebar = ports.sidebar ?? SidebarLayoutsPort.none
  return Layer.mergeAll(
    RequestsPort.layer(ports.requests ?? RequestsPort.none),
    FilesPort.layer(ports.files ?? FilesPort.none),
    SessionHost.layer(ports.sessions ?? SessionHost.none),
    SettingsSource.layer(ports.settings ?? SettingsSource.none),
    Terminals.layer(ports.terminals ?? Terminals.none),
    SidebarLayoutsPort.layer(sidebar),
    SidebarOverviewPort.layer(ports.sidebarOverview ?? layoutsOverviewSource(sidebar)),
    WorkspaceFilesPort.layer(ports.workspaceFiles ?? WorkspaceFilesPort.none),
    // ── Wave 4, lane C: the agent tools' tokens ──
    AgentTokens.layer(ports.agentTools ?? AgentTokens.none),
    // ── Wave 5, lane C: the plugins ──
    Plugins.layer(ports.plugins ?? Plugins.none),
    // ── Wave wcs1023, lane C: the git domain ──
    GitPort.layer(ports.git ?? GitPort.none),
    // ── Issue #266: the server domain ──
    ServerInfoPort.layer(ports.serverInfo ?? ServerInfoPort.none),
    // ── PRDCT-4321: the server's History ──
    HistoryPort.layer(ports.history ?? HistoryPort.none),
    // ── ADR 0004: the routines ──
    Routines.layer(ports.routines ?? Routines.none),
    // ── PRDCT-4327: the digests ──
    DigestsPort.layer(ports.digests ?? DigestsPort.none),
    // ── Mobile wave, lane A: the devices ──
    DevicesPort.layer(ports.devices ?? DevicesPort.none),
    // ── PRDCT-4411: the speech ──
    SpeechPort.layer(ports.speech ?? SpeechPort.none)
  )
}
