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

export type { StartInput, Unsubscribe } from './sessions/port'
export { SessionHost, type SessionHostService } from './sessions/port'
import { SettingsSource, type SettingsSourceService } from './settings/port'

export { SettingsSource, type SettingsSourceService } from './settings/port'

export interface ServerPorts {
  /** Lane A: the sessions. `SessionHost.none` when absent. */
  readonly sessions?: SessionHostService
  /** Lane D: the settings. `SettingsSource.none` when absent. */
  readonly settings?: SettingsSourceService
  // ── Lane B: terminals · Lane C: sidebar ──
}

/** Every port as a layer, the domain's `none` where the entry gave nothing. */
export const PortsLive = (ports: ServerPorts): Layer.Layer<SessionHost | SettingsSource> =>
  Layer.mergeAll(
    SessionHost.layer(ports.sessions ?? SessionHost.none),
    SettingsSource.layer(ports.settings ?? SettingsSource.none)
  )
