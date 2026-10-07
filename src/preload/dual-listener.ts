/**
 * A listener on two transports for an event main sends on BOTH: over the
 * window's own IPC channel and, once the server runs, as a server event on
 * the push channel (the settings events, lane D: one source in main, two
 * fan-outs, `src/main/settings/source.ts`). The window must hear each event
 * exactly once, whichever transport is up:
 *
 *  - the IPC listener is bound at once, so nothing is missed while the
 *    endpoint is asked of main and the socket says hello;
 *  - the push listener is bound as soon as a backing exists, and the IPC one
 *    is dropped only when the socket is OPEN (a push peer hears nothing
 *    before its welcome), in the welcome's own tick, so no event lands twice;
 *  - while the socket is down (a reconnection backs off up to ten seconds)
 *    the IPC listener is bound again, and dropped again at the next welcome.
 *
 * Pure, and beside the preload rather than in the client package: the
 * preload may import only the client's router statically (the lazy-load
 * guard, `src/main/server/lazy-load.test.ts`), and this needs nothing of
 * the client at runtime. The transports come in as functions, so the preload
 * hands it `ipcRenderer` and the router's backing, and a test hands it fakes. Round 1
 * of the lane's verifier found the swap-on-connect version losing the events
 * between the IPC drop and the welcome, and nothing in the suite counting
 * deliveries; this module and its test are the answer.
 */
import type { ServerEvent, ServerEventEnvelope } from '@clave/contract/events'
import type { PushStatus } from '@clave/client'

export type Unsubscribe = () => void

type WorkspacesStateChanged = Extract<ServerEvent, { _tag: 'workspaces.state_changed' }>

/**
 * What a window takes from a workspace change on the push channel: the
 * registry and the pins, unless the change is its own (the event's `origin`
 * is the key `mine` answers), which it drops the way the IPC handler skips
 * the sender. `mine` is read at each event, since the window's key arrives
 * asynchronously after the listener is bound.
 */
export const workspaceStatePick =
  (mine: () => string | null) =>
  (event: WorkspacesStateChanged): { workspaces: unknown[]; pins: unknown[] } | undefined =>
    event.origin !== null && event.origin === mine()
      ? undefined
      : { workspaces: [...event.workspaces], pins: [...event.pins] }

/** What the listener needs of a push client: `PushClient` is one. */
export interface PushLike {
  readonly status: PushStatus
  connect(): unknown
  onEvent(listener: (envelope: ServerEventEnvelope) => void): Unsubscribe
  onStatus(listener: (status: PushStatus) => void): Unsubscribe
}

export interface DualListenerOptions<E extends ServerEvent['_tag'], T> {
  /** Bind the IPC listener for the channel, delivering the value as main sends it. */
  readonly bindIpc: (callback: (value: T) => void) => Unsubscribe
  /** The push client once a backing exists, null while there is none. */
  readonly backing: () => Promise<PushLike | null>
  /** The server event's tag. */
  readonly tag: E
  /** The value the callback receives for a server event; `undefined` drops it. */
  readonly pick: (event: Extract<ServerEvent, { _tag: E }>) => T | undefined
}

export function dualListener<E extends ServerEvent['_tag'], T>(
  options: DualListenerOptions<E, T>
): (callback: (value: T) => void) => Unsubscribe {
  return (callback) => {
    let ipcOff: Unsubscribe | null = options.bindIpc(callback)
    let pushOff: Unsubscribe | null = null
    let statusOff: Unsubscribe | null = null
    let gone = false
    const bindIpc = (): void => {
      if (!ipcOff && !gone) ipcOff = options.bindIpc(callback)
    }
    const dropIpc = (): void => {
      ipcOff?.()
      ipcOff = null
    }
    void options.backing().then(
      (push) => {
        if (gone || !push) return
        try {
          push.connect()
        } catch {
          // Closed for good (the token refused): the IPC listener stays.
          return
        }
        pushOff = push.onEvent((envelope) => {
          // Only an open socket counts: before the welcome the window is on IPC.
          if (push.status !== 'open' || envelope.event._tag !== options.tag) return
          const value = options.pick(envelope.event as Extract<ServerEvent, { _tag: E }>)
          if (value !== undefined) callback(value)
        })
        // The transport follows the socket: IPC while it is down, push while
        // it is open. The status callback runs in the welcome's own tick,
        // before any event frame, so the handover never doubles a delivery.
        statusOff = push.onStatus((status) => {
          if (status === 'open') dropIpc()
          else bindIpc()
        })
        if (push.status === 'open') dropIpc()
      },
      () => {
        /* no server: the IPC listener stays */
      }
    )
    return () => {
      gone = true
      dropIpc()
      pushOff?.()
      statusOff?.()
    }
  }
}
