/**
 * The one place a server connection's fate is written down (PRDCT-4165).
 * Main holds no connection to a saved server: each window's preload does,
 * and tells main when a connection's state changes; the credential read
 * happens here in main and fails here. Both land in the main log as one
 * line naming the server and the reason, in the closed vocabulary of
 * `ServerConnectionStatus` and nothing else from the window (a window's
 * status is privileged, but the log never echoes free text from it), and
 * never a token or an address. Under `--test-no-activate` the same lines are
 * kept on the end-to-end hooks, so a spec reads them without the person's
 * log file. Nothing here imports Electron: the logger is handed in.
 */
import type { ServerConnectionStatus } from '@clave/contract/fleet'
import { installE2eHooks } from '../sessions/e2e-hooks'
import { TEST_NO_ACTIVATE } from '../test-mode'

const STATES: ReadonlySet<ServerConnectionStatus['state']> = new Set([
  'connecting',
  'reconnecting',
  'connected',
  'disconnected',
  'offline',
  'unauthorized'
])
const ERRORS: ReadonlySet<NonNullable<ServerConnectionStatus['error']>> = new Set([
  'unreachable',
  'unauthorized',
  'credentials-unavailable'
])

/** What each reason means, in the words the Servers page uses. */
const REASONS: Record<NonNullable<ServerConnectionStatus['error']>, string> = {
  unreachable: 'unreachable: the server did not answer at its address',
  unauthorized: 'the server refused the token',
  'credentials-unavailable':
    'credentials unavailable: the saved token could not be read on this Mac'
}

export interface ConnectionLogger {
  info(line: string): void
  warn(line: string): void
}

const lines: string[] = []
let hooked = false
const keep = (line: string): void => {
  if (!TEST_NO_ACTIVATE) return
  if (!hooked) {
    hooked = true
    installE2eHooks({ fleetLog: lines })
  }
  lines.push(line)
}

/** The line for a state change a window reported, or null for a payload that
 *  is not a status of the closed vocabulary. */
export function describeConnectionChange(
  status: unknown,
  name: string,
  windowId: number | null
): { line: string; level: 'info' | 'warn' } | null {
  if (!status || typeof status !== 'object') return null
  const { serverId, state, error, attempt } = status as Partial<ServerConnectionStatus>
  if (typeof serverId !== 'string' || !serverId || !state || !STATES.has(state)) return null
  const where = windowId === null ? '' : ` (window ${windowId})`
  const reason = error && ERRORS.has(error) ? `, ${REASONS[error]}` : ''
  const tries = typeof attempt === 'number' && attempt > 0 ? `, attempt ${attempt}` : ''
  const line = `[fleet] ${name} (${serverId})${where}: ${state}${reason}${tries}`
  const level = state === 'offline' || state === 'unauthorized' ? 'warn' : 'info'
  return { line, level }
}

/** Write a state change a window reported. */
export function recordConnectionChange(
  logger: ConnectionLogger,
  status: unknown,
  name: string,
  windowId: number | null
): void {
  const described = describeConnectionChange(status, name, windowId)
  if (!described) return
  logger[described.level](described.line)
  keep(described.line)
}

/** The registry's one sentence for a credential it could not open
 *  (`ServerConnectionRegistry.endpoint`); any other refusal of an endpoint
 *  (a disabled or unknown connection) is not a credential failure. */
export const CREDENTIAL_UNAVAILABLE =
  'The saved server credential is unavailable. Enter its token again.'

export function isCredentialUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === CREDENTIAL_UNAVAILABLE
}

/** The servers whose credential failed since it last opened: a failure is
 *  written once, not on every retry of every window. */
const failedCredentials = new Set<string>()

/** Write a credential that could not be read for a connect, the first time
 *  it fails since it last opened: the reason is the registry's own safe
 *  sentence, never the adapter's. Answers whether a line was written. */
export function recordCredentialFailure(
  logger: ConnectionLogger,
  serverId: string,
  name: string,
  reason: string
): boolean {
  if (failedCredentials.has(serverId)) return false
  failedCredentials.add(serverId)
  const line = `[fleet] ${name} (${serverId}): credentials unavailable, ${reason}`
  logger.warn(line)
  keep(line)
  return true
}

/** The credential opened: the next failure is written again. */
export function recordCredentialOpened(serverId: string): void {
  failedCredentials.delete(serverId)
}
