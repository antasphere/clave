/**
 * The states the phone shows, in the desktop's inks: a machine's
 * reachability as a status said in words (`.status-text`), a session's
 * state as the sidebar's status glyph and its tone.
 */
import type { PhoneSessionState, Reachability } from '../state/session-state'
import type { DotStatus, Status } from './components'
import type { Theme } from './theme'

/** The reachability of a machine, as a status said in words. */
export const reachStatus = (reach: Reachability | undefined): Status =>
  reach === 'reachable'
    ? 'connected'
    : reach === 'connecting'
      ? 'connecting'
      : reach
        ? 'error'
        : 'neutral'

/** The sidebar's status glyph for the phone's five states. */
export const dotOf: Record<PhoneSessionState, DotStatus> = {
  working: 'working',
  waiting: 'waiting',
  idle: 'ready',
  finished: 'inactive',
  error: 'inactive'
}

/** The state said in words at a row's end, in the sidebar's tones: blue for
 *  working, amber for waiting, the destructive ink for an error, dim for the rest. */
export const stateInk = (t: Theme, state: PhoneSessionState): string =>
  state === 'working'
    ? t.colors.statusWorking
    : state === 'waiting'
      ? t.colors.statusWaiting
      : state === 'error'
        ? t.colors.destructive
        : t.colors.textTertiary
