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
  /** The server's own name set from a Mac (PRDCT-4241), valid already;
   *  answers the info with it. Absent on a server that keeps no name. */
  readonly setName?: (name: string) => ServerInfo
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
  /** A server the app runs: the app's version, and no upgrade of its own;
   *  `name` is the server's own name (PRDCT-4149) when the entry knows it,
   *  read at each use when given as a function, and `setName` stores a new
   *  one (PRDCT-4241) when the entry can. */
  static appRun(
    version: string,
    name?: string | (() => string),
    setName?: (name: string) => string
  ): ServerInfoService {
    const upgrade: ServerUpgradeStatus = {
      supported: false,
      reason: APP_RUN_REASON,
      state: 'idle'
    }
    const current = (): string | undefined => (typeof name === 'function' ? name() : name)
    const info = (): ServerInfo => {
      const own = current()
      return { version, installRef: null, upgrade, ...(own ? { name: own } : {}) }
    }
    return {
      info,
      ...(setName
        ? {
            setName: (next: string): ServerInfo => {
              setName(next)
              return info()
            }
          }
        : {}),
      requestUpgrade: () => {
        throw new CapabilityUnavailable({ capability: 'server-upgrade', message: APP_RUN_REASON })
      },
      subscribe: () => () => {}
    }
  }
}
