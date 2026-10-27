/**
 * The server domain (issue #266): which Clave version a server runs, the ref
 * it was installed from, and the one maintenance act a Mac may ask of it,
 * upgrading itself to the Mac's own version.
 *
 * - `GetServerInfo`: the version (`--app-version` when the entry was given
 *   one, the checkout's package.json otherwise: a beta's package.json says
 *   the stable version it was cut from), the ref `install-server.sh`
 *   installed (null when it did not install this server), and the upgrade's
 *   state.
 * - `RequestServerUpgrade`: the VERSION is the only input. The server maps it
 *   to the release tag `v<version>` itself and passes nothing else from the
 *   wire to the install script: no ref, repository, URL, path or flag. A
 *   version that is not strict semver is `InvalidUpgradeVersion`; a server
 *   that cannot upgrade itself (run by the app, or not installed by the
 *   script) is `CapabilityUnavailable`.
 *
 * `server.upgrade_changed` (in `ServerUpgradeEvent`) goes to every attached
 * client at each change of the upgrade's state.
 */
import { Schema } from 'effect'
import { Command, Query } from '@structure-ai/cqrs'
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import { CapabilityUnavailable } from './errors'

// The rule for what an upgrade accepts lives in a module of its own with no
// Effect in it, so main's boot can apply it without loading Effect.
export { isReleaseTag, isReleaseVersion } from './release-version'

export const ServerUpgradeState = Schema.Literal('idle', 'waiting-for-idle', 'running', 'failed')
export type ServerUpgradeState = typeof ServerUpgradeState.Type

export const ServerUpgradeStatus = Schema.Struct({
  /** Whether this server can upgrade itself at all. */
  supported: Schema.Boolean,
  /** Why it cannot, in a sentence the Mac shows. */
  reason: Schema.optional(Schema.String),
  state: ServerUpgradeState,
  /** The version asked for, semver without the `v`. */
  target: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.Literal('when-idle', 'now')),
  /** The last lines of the install log, when the run failed. */
  error: Schema.optional(Schema.String),
  /** Epoch milliseconds the state was entered, the server's clock. */
  since: Schema.optional(Schema.Number)
})
export type ServerUpgradeStatus = typeof ServerUpgradeStatus.Type

export const ServerInfo = Schema.Struct({
  version: Schema.String,
  installRef: Schema.NullOr(Schema.String),
  upgrade: ServerUpgradeStatus
})
export type ServerInfo = typeof ServerInfo.Type

/** The version asked for is not one a release tag can name. */
export class InvalidUpgradeVersion extends Schema.TaggedError<InvalidUpgradeVersion>()(
  'InvalidUpgradeVersion',
  { message: Schema.NonEmptyString }
) {}

export const GetServerInfo = Query.define('GetServerInfo', {
  payload: Schema.Struct({}),
  success: ServerInfo,
  failure: CapabilityUnavailable
})

export const RequestServerUpgrade = Command.define('RequestServerUpgrade', {
  payload: Schema.Struct({
    version: Schema.String,
    when: Schema.Literal('idle', 'now')
  }),
  success: ServerUpgradeStatus,
  failure: Schema.Union(CapabilityUnavailable, InvalidUpgradeVersion)
})
export type ServerUpgradeRequest = typeof RequestServerUpgrade.payload.Type

export const ServerUpgradeEvent = Schema.TaggedStruct('server.upgrade_changed', {
  status: ServerUpgradeStatus
})
export type ServerUpgradeEvent = typeof ServerUpgradeEvent.Type

export const serverInfoGroup = ApiGroup.make('server')
  .add(HttpCqrs.queryEndpoint('info', '/server/info', GetServerInfo))
  .add(HttpCqrs.commandEndpoint('upgrade', '/server/upgrade', RequestServerUpgrade))
