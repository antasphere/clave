/**
 * The words Settings → Mobile shows for the relay client's state (issue
 * #407). One plain function, so the page and its test read the same rule.
 */
import type { MobileRelayState, MobileRelayStatus } from '../../../shared/mobile-relay-types'

/** The state's name, as the page's badge shows it. */
export const RELAY_STATE_LABELS: Record<MobileRelayState, string> = {
  off: 'Off',
  'signed-out': 'Signed out',
  claiming: 'Claiming',
  connecting: 'Connecting',
  connected: 'Connected',
  waiting: 'Waiting',
  refused: 'Refused'
}

/** The tone of the state, as `.status-text`'s `data-status` takes it: green
 *  connected, red refused, amber on the way or waiting, quiet when off. */
export function relayStateTone(
  state: MobileRelayState
): 'connected' | 'connecting' | 'error' | undefined {
  if (state === 'connected') return 'connected'
  if (state === 'refused') return 'error'
  if (state === 'off') return undefined
  return 'connecting'
}

/** One sentence that says what the state means for the person, given the
 *  address they saved (empty when none). */
export function relayStateSentence(status: MobileRelayStatus, saved: string): string {
  switch (status.state) {
    case 'off':
      return saved
        ? 'The relay client is not running on this server.'
        : 'No relay address: phones reach this Mac only over its private address.'
    case 'signed-out':
      return 'Sign in to Antasphere (Settings → Connections) so this Mac can claim its place on the relay.'
    case 'claiming':
      return 'Asking the relay for this Mac’s credential.'
    case 'connecting':
      return 'Connecting to the relay.'
    case 'connected':
      return 'Connected: your phones can reach this Mac through the relay from any network.'
    case 'waiting':
      return 'The last attempt failed; Clave tries again on its own.'
    case 'refused':
      return 'The relay or the address was refused; Clave tries again, but this needs a change.'
  }
}
