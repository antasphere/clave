import type {
  ServerConnectionStatus,
  ServerVersionFailure,
  ServerVersionStatus
} from '@clave/contract/fleet'
import type { ServerUpgradeFailureCode, ServerUpgradePhase } from '@clave/contract/upgrade-failure'

type StatusTone = 'connected' | 'connecting' | 'error' | 'idle'

const STATE_LABELS: Record<ServerConnectionStatus['state'], string> = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  offline: 'Unreachable',
  unauthorized: 'Token refused'
}

const STATE_TONES: Record<ServerConnectionStatus['state'], StatusTone> = {
  connecting: 'connecting',
  reconnecting: 'connecting',
  connected: 'connected',
  disconnected: 'idle',
  offline: 'error',
  unauthorized: 'error'
}

const CONNECTION_ERRORS: Record<NonNullable<ServerConnectionStatus['error']>, string> = {
  unauthorized:
    'The server refused the token. Remove this server and add it again with its current token.',
  unreachable:
    'The server did not answer at this address. Check the address and that the server is running.',
  'credentials-unavailable':
    'The saved token could not be read from this Mac. Remove this server and add it again.'
}

export function describeServerState(
  status: ServerConnectionStatus | undefined,
  enabled: boolean
): { label: string; error: string | null; tone: StatusTone } {
  if (!enabled) return { label: 'Disconnected', error: null, tone: 'idle' }
  return {
    label: status ? STATE_LABELS[status.state] : 'Connecting…',
    error: status?.error ? CONNECTION_ERRORS[status.error] : null,
    tone: status ? STATE_TONES[status.state] : 'connecting'
  }
}

// Only these sentences from ServerConnectionRegistry are safe to show. An
// unexpected adapter error may carry credentials or private source details.
export const SAVE_ERRORS: ReadonlySet<string> = new Set([
  'Enter a server name of at most 120 characters.',
  'Enter a valid Clave server address.',
  'Enter a valid Clave server base address without credentials, path, query or fragment.',
  'Too many saved server connections.',
  'Enter a valid bearer token of at most 8192 characters.',
  'A bearer token is required.',
  'Secure credential storage is unavailable. The connection was not saved.',
  'Could not allocate a server connection identity.',
  'This server connection is disconnected.',
  'The saved server credential is unavailable. Enter its token again.',
  'Unknown server connection.',
  'Could not save server connections. Previous settings were retained.',
  'Checked reads are required.',
  'Saved server connections could not be read. The document was left unchanged.'
])

export function describeAddError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const sentence = message.startsWith("Error invoking remote method 'server:fleet:save': Error: ")
    ? message.slice(message.lastIndexOf('Error: ') + 'Error: '.length)
    : message
  return SAVE_ERRORS.has(sentence)
    ? sentence
    : 'The server operation failed. Check its connection and try again.'
}

// ── Issue #266: a saved server's version against this app's ──

/** What "Upgrade now" asks the person to accept first. */
export const UPGRADE_NOW_WARNING =
  'Upgrading restarts the server: its running sessions end and come back as ended tabs to Resume.'

const DEV_BUILD =
  'Older than this app. A development build does not upgrade servers: run install-server.sh on the server.'

/** One fixed sentence per way a server's upgrade fails. `target` is the
 *  version this Mac decided on, never text from the server. */
export const UPGRADE_FAILURE_SENTENCES: Record<
  ServerUpgradeFailureCode,
  (target: string) => string
> = {
  'invalid-options': () =>
    'The install script refused its saved options. Run it once on the server to see why.',
  'run-as-root': () => 'The server runs as root, and the install script refuses to.',
  'unsupported-platform': () => 'The install script supports Linux and macOS only.',
  'missing-tools': () =>
    'The server is missing a tool the build needs: git, Node, npm or a C toolchain.',
  'node-too-old': () => "The server's Node is too old (22 or newer is needed).",
  'token-file-missing': () => 'The token file the server was installed with is gone.',
  'tailscale-down': () => 'Tailscale is not up on the server, and the server listens on it.',
  'wildcard-address': () => 'The saved listen address is a wildcard, which the script refuses.',
  'release-lookup-failed': () => 'The server could not read the list of releases from GitHub.',
  'repository-unreachable': () => 'The server could not reach its Git repository.',
  'no-such-release': (target) => `The server could not find the release ${target}.`,
  'ref-moved': (target) => `The release ${target} changed while the server downloaded it.`,
  'release-too-old': (target) => `The release ${target} has no standalone server mode.`,
  'build-incomplete': (target) => `The build of ${target} did not produce the server.`,
  'service-enable-failed': () => "The server's service could not be enabled.",
  'invalid-service-file': () => 'The service file the install script wrote was refused.',
  'no-service-manager': () => "The server's user has no systemd user manager running.",
  'no-login-session': () =>
    "The server's user is not logged in on that Mac, so launchd cannot run the service.",
  'server-did-not-answer': (target) =>
    `${target} did not answer within a minute, and the server is stopped.`,
  'rolled-back': () => 'The new release did not start; the server went back to the previous one.',
  'rollback-failed': () => 'The new release did not start, and neither did the previous one.',
  'launcher-missing': () =>
    'The server has no systemd-run, so it cannot upgrade itself. Run install-server.sh on the server.',
  'launch-failed': () => 'The server could not start the install script.',
  unknown: () => 'The install script stopped without saying why.'
}

/** Where the script was, for a failure with no code of its own. */
export const UPGRADE_PHASE_WORDS: Record<ServerUpgradePhase, string> = {
  resolve: 'looking up the release',
  clone: 'downloading the release',
  dependencies: 'installing dependencies',
  build: 'building',
  service: 'setting up the service',
  restart: 'restarting the server',
  health: 'waiting for the server to answer',
  rollback: 'going back to the previous release'
}

/** A failed run in plain words: its sentence, then its exit and log on a line of their own. */
export function describeUpgradeFailure(failure: ServerVersionFailure, target: string): string {
  const code = failure.code ?? 'unknown'
  const sentence =
    code === 'unknown' && failure.phase
      ? `The upgrade failed while ${UPGRADE_PHASE_WORDS[failure.phase]}.`
      : UPGRADE_FAILURE_SENTENCES[code](target)
  const meta = [
    failure.exitCode !== undefined && `Exit ${failure.exitCode}.`,
    failure.logPath && `Full log on the server: ${failure.logPath}`
  ].filter(Boolean)
  return meta.length ? `${sentence}\n${meta.join(' ')}` : sentence
}

/** Why the last upgrade failed: the server's run, or this Mac's refused ask. */
function failureText(status: ServerVersionStatus): string {
  if (status.failure) return describeUpgradeFailure(status.failure, status.target ?? '')
  return status.error ?? UPGRADE_FAILURE_SENTENCES.unknown('')
}

export interface ServerVersionText {
  /** "Version 3.0.0-beta.7", null when the server did not say. */
  version: string | null
  /** Where it stands against this app, in plain words. */
  state: string
  tone: StatusTone
  /** The command to run on the server by hand, for an older server. */
  command?: string
  /** Whether "Upgrade now" is offered. */
  upgradeNow: boolean
}

/** The version line of a saved server, null when nothing is known yet. */
export function describeServerVersion(
  status: ServerVersionStatus | undefined
): ServerVersionText | null {
  if (!status || status.kind === 'unreachable') return null
  const version = status.serverVersion ? `Version ${status.serverVersion}` : null
  const line = (
    state: string,
    tone: ServerVersionText['tone'],
    upgradeNow = false
  ): ServerVersionText => ({ version, state, tone, upgradeNow })
  switch (status.kind) {
    case 'match':
      return line('Same version as this app', 'connected')
    case 'upgrade':
      return status.automatic
        ? line(`Upgrading to ${status.target} once no agent is working`, 'connecting', true)
        : line(DEV_BUILD, 'idle')
    case 'upgrading':
      // Another Mac's upgrade on a server as new as this app: shown, not offered.
      return status.upgradeState === 'running'
        ? line(`Upgrading to ${status.target}…`, 'connecting')
        : line(
            `Upgrading to ${status.target} once no agent is working`,
            'connecting',
            status.automatic && status.ownAction !== false
          )
    case 'failed':
      if (status.ownAction === false)
        return line(`Upgrade to ${status.target} failed: ${failureText(status)}`, 'error')
      return status.automatic
        ? line(`Upgrade to ${status.target} failed: ${failureText(status)}`, 'error', true)
        : line(DEV_BUILD, 'idle')
    case 'server-newer':
      return line('Newer than this app', 'idle')
    case 'custom-ref':
      return line(
        `Installed from ${status.installRef ?? 'a custom ref'}; upgrade it on the server`,
        'idle'
      )
    case 'manual':
      return {
        ...line('Older Clave server: run this on the server', 'connecting'),
        ...(status.command && { command: status.command })
      }
    case 'unsupported': {
      const why = `This server does not upgrade from the Mac${status.reason ? `: ${status.reason}` : ''}`
      return status.command
        ? {
            ...line(
              `${why}. Install it with the script, so this Mac keeps it on its version:`,
              'idle'
            ),
            command: status.command
          }
        : line(why, 'idle')
    }
  }
}
