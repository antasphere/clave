import type { ServerConnectionStatus } from '@clave/contract/fleet'

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
