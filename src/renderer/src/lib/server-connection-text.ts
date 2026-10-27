import type { ServerConnectionStatus, ServerVersionStatus } from '@clave/contract/fleet'

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
        return line(`Upgrade to ${status.target} failed: ${status.error}`, 'error')
      return status.automatic
        ? line(`Upgrade to ${status.target} failed: ${status.error}`, 'error', true)
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
