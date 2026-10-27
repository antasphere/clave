/**
 * What a failed server upgrade may say (issue #266): a code and a phase, each
 * from a closed list, and nothing else from the run. The install script
 * writes `code=<code>` and `phase=<phase>` lines to its status file; the
 * server keeps only values found here, so no text a command printed (or wrote
 * into that file) ever leaves the server. The Mac turns each code into a
 * fixed sentence. Pure and free of Effect, like `release-version.ts`: main
 * and the script's tests read the lists without loading Effect.
 */

/** One code per way an upgrade run can fail, named by what went wrong. */
export const SERVER_UPGRADE_FAILURE_CODES = [
  // install-server.sh, before it touches anything
  'invalid-options',
  'run-as-root',
  'unsupported-platform',
  'missing-tools',
  'node-too-old',
  'token-file-missing',
  'tailscale-down',
  'wildcard-address',
  // finding and building the release
  'release-lookup-failed',
  'repository-unreachable',
  'no-such-release',
  'ref-moved',
  'release-too-old',
  'build-incomplete',
  // the service
  'service-enable-failed',
  'invalid-service-file',
  'no-service-manager',
  'no-login-session',
  'server-did-not-answer',
  'rolled-back',
  'rollback-failed',
  // the server, starting the script
  'launcher-missing',
  'launch-failed',
  // the script ended without a code (a command failing under `set -e`)
  'unknown'
] as const
export type ServerUpgradeFailureCode = (typeof SERVER_UPGRADE_FAILURE_CODES)[number]

/** Where the script was when it stopped, in its order. */
export const SERVER_UPGRADE_PHASES = [
  'resolve',
  'clone',
  'dependencies',
  'build',
  'service',
  'restart',
  'health',
  'rollback'
] as const
export type ServerUpgradePhase = (typeof SERVER_UPGRADE_PHASES)[number]

export function isServerUpgradeFailureCode(value: unknown): value is ServerUpgradeFailureCode {
  return (SERVER_UPGRADE_FAILURE_CODES as readonly unknown[]).includes(value)
}

export function isServerUpgradePhase(value: unknown): value is ServerUpgradePhase {
  return (SERVER_UPGRADE_PHASES as readonly unknown[]).includes(value)
}
