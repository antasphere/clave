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
 *
 * A failed run is told by a code and a phase from closed lists
 * (`upgrade-failure.ts`), its exit code and the path of the server's private
 * log: no text from the run ever leaves the server.
 */
import { Option, Schema } from 'effect'
import { Command, Query } from '@structure-ai/cqrs'
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import { CapabilityUnavailable } from './errors'
import {
  SERVER_UPGRADE_FAILURE_CODES,
  SERVER_UPGRADE_PHASES,
  isServerUpgradeFailureCode,
  isServerUpgradePhase
} from './upgrade-failure'

// The rule for what an upgrade accepts, and the lists a failure is told
// with, live in modules of their own with no Effect in them, so main's boot
// can apply them without loading Effect.
export { isReleaseTag, isReleaseVersion } from './release-version'
export {
  SERVER_UPGRADE_FAILURE_CODES,
  SERVER_UPGRADE_PHASES,
  isServerUpgradeFailureCode,
  isServerUpgradePhase
}

export const ServerUpgradeState = Schema.Literal('idle', 'waiting-for-idle', 'running', 'failed')
export type ServerUpgradeState = typeof ServerUpgradeState.Type

export const ServerUpgradeFailureCode = Schema.Literal(...SERVER_UPGRADE_FAILURE_CODES)
export type ServerUpgradeFailureCode = typeof ServerUpgradeFailureCode.Type
export const ServerUpgradePhase = Schema.Literal(...SERVER_UPGRADE_PHASES)
export type ServerUpgradePhase = typeof ServerUpgradePhase.Type

/** A value from a closed list, read as absent when this Mac does not know it
 *  (a newer server's new code), so the rest of the status still decodes. */
const known = <A extends string>(
  literal: Schema.Schema<A>,
  is: (value: unknown) => value is A
): Schema.PropertySignature<'?:', A, never, '?:', string, false, never> =>
  Schema.optionalToOptional(Schema.String, literal, {
    decode: (value) => Option.filter(value, is),
    encode: (value) => value
  })

/** How a run failed: values from closed lists and the server's own numbers and path. */
export const ServerUpgradeFailure = Schema.Struct({
  /** What went wrong, `unknown` when the script stopped without saying. */
  code: known(ServerUpgradeFailureCode, isServerUpgradeFailureCode),
  /** Where the script was when it stopped. */
  phase: known(ServerUpgradePhase, isServerUpgradePhase),
  /** The script's exit code; absent when it never started. */
  exitCode: Schema.optional(Schema.Number),
  /** The server's private log of the run, `<dataDir>/upgrade/upgrade.log`. */
  logPath: Schema.optional(Schema.String)
})
export type ServerUpgradeFailure = typeof ServerUpgradeFailure.Type

export const ServerUpgradeStatus = Schema.Struct({
  /** Whether this server can upgrade itself at all. */
  supported: Schema.Boolean,
  /** Why it cannot, in a sentence the Mac shows. */
  reason: Schema.optional(Schema.String),
  state: ServerUpgradeState,
  /** The version asked for, semver without the `v`. */
  target: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.Literal('when-idle', 'now')),
  /** How the run failed, when it did. */
  failure: Schema.optional(ServerUpgradeFailure),
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
