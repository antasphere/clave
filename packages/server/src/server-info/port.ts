/**
 * The server info port (issue #266): the version this server runs, the ref
 * `install-server.sh` installed it from, and its self-upgrade. Three shapes
 * stand behind it:
 *
 * - `ServerInfoPort.appRun(version)`: the server the desktop app runs, in its
 *   own process or as its child. It reports the app's version and never
 *   upgrades itself: it updates with the app.
 * - the daemon's own implementation (`src/main/server/self-upgrade.ts`), which
 *   runs the install script it was installed with, once no agent works.
 * - `ServerInfoPort.none`: a server with nothing behind it, which answers
 *   `CapabilityUnavailable` to both calls.
 *
 * `requestUpgrade` throws the contract's `CapabilityUnavailable` or
 * `InvalidUpgradeVersion`; the handlers turn anything else into the former.
 */
import { Context, Layer } from 'effect'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type {
  ServerInfo,
  ServerUpgradeRequest,
  ServerUpgradeStatus
} from '@clave/contract/server-info'
import type { Unsubscribe } from '../sessions/port'

export interface ServerInfoService {
  readonly info: () => ServerInfo
  readonly requestUpgrade: (request: ServerUpgradeRequest) => ServerUpgradeStatus
  /** Told every change of the upgrade's state; published as `server.upgrade_changed`. */
  readonly subscribe: (listener: (status: ServerUpgradeStatus) => void) => Unsubscribe
}

/** The sentence a Mac shows for a server the app runs. */
export const APP_RUN_REASON = 'This server is run by the app; it updates with it'

const NO_SERVER_INFO = new CapabilityUnavailable({
  capability: 'server-info',
  message: 'This server reports no version and cannot upgrade itself.'
})

export class ServerInfoPort extends Context.Tag('@clave/server/ServerInfo')<
  ServerInfoPort,
  ServerInfoService
>() {
  static layer(service: ServerInfoService): Layer.Layer<ServerInfoPort> {
    return Layer.succeed(ServerInfoPort, service)
  }
  static readonly none: ServerInfoService = {
    info: () => {
      throw NO_SERVER_INFO
    },
    requestUpgrade: () => {
      throw NO_SERVER_INFO
    },
    subscribe: () => () => {}
  }
  /** A server the app runs: the app's version, and no upgrade of its own. */
  static appRun(version: string): ServerInfoService {
    const upgrade: ServerUpgradeStatus = {
      supported: false,
      reason: APP_RUN_REASON,
      state: 'idle'
    }
    return {
      info: () => ({ version, installRef: null, upgrade }),
      requestUpgrade: () => {
        throw new CapabilityUnavailable({ capability: 'server-upgrade', message: APP_RUN_REASON })
      },
      subscribe: () => () => {}
    }
  }
}
