/**
 * A listener on two transports for an event main sends on BOTH: over the
 * window's own IPC channel and, once the server runs, as a server event on
 * the push channel (the settings events, lane D: one source in main, two
 * fan-outs, `src/main/settings/source.ts`). The window must hear each event
 * exactly once, whichever transport is up:
 *
 *  - the IPC listener is bound at once, so nothing is missed while the
 *    endpoint is asked of main and the socket says hello;
 *  - the push listener is bound as soon as a push client is there, and the
 *    IPC one is dropped only when the socket is OPEN (a push peer hears
 *    nothing before its welcome), in the welcome's own tick, so no event
 *    lands twice;
 *  - while the socket is down (a reconnection backs off up to ten seconds)
 *    the IPC listener is bound again, and dropped again at the next welcome.
 *
 * The push client comes through a WAIT, not a one-shot ask (wave 4, lane B,
 * PRDCT-3295): a window that binds its listeners before main names the
 * server used to ask the router once, be told null, and stay on IPC for the
 * rest of its life; attached, main's IPC fan-out is main's own managers, so
 * that window never heard the server's settings change. `onPush` is called
 * once, at bind time, with the `ready` to run when a push client exists (at
 * once when it already does), and answers the function that withdraws a wait
 * that has not fired, which unsubscribe calls: a listener bound and released
 * before the server comes leaves nothing behind.
 *
 * The catch-up: between the moment the window read its state (over IPC, from
 * main) and the welcome, the server's state may have moved with nobody
 * listening. A listener given `catchUp` reads the server's own read model at
 * every welcome it witnesses and hands each value to the callback as if it
 * were an event; a read whose answer lands after a newer push event of the
 * same tag is dropped, since the event is what is true now. A listener bound
 * while the socket is already open witnesses no welcome and reads nothing:
 * its caller reads the server itself, through the routed call it makes next.
 *
 * Pure, and beside the preload rather than in the client package: the
 * preload may import only the client's router statically (the lazy-load
 * guard, `src/main/server/lazy-load.test.ts`), and this needs nothing of
 * the client at runtime. The transports come in as functions, so the preload
 * hands it `ipcRenderer` and its own `onServerAvailable`, and a test hands it
 * fakes. Round 1 of wave 2 lane D's verifier found the swap-on-connect
 * version losing the events between the IPC drop and the welcome, and
 * nothing in the suite counting deliveries; this module and its test are the
 * answer.
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
  /** Run `ready` with the push client once there is one (at once when there
   *  already is); the answer withdraws a wait that has not fired. */
  readonly onPush: (ready: (push: PushLike) => void) => Unsubscribe
  /** The server event's tag. */
  readonly tag: E
  /** The value the callback receives for a server event; `undefined` drops it. */
  readonly pick: (event: Extract<ServerEvent, { _tag: E }>) => T | undefined
  /** The server's read model for this listener, read at every welcome the
   *  listener witnesses and delivered value by value; absent, nothing is read. */
  readonly catchUp?: () => Promise<ReadonlyArray<T>>
}

export function dualListener<E extends ServerEvent['_tag'], T>(
  options: DualListenerOptions<E, T>
): (callback: (value: T) => void) => Unsubscribe {
  return (callback) => {
    let ipcOff: Unsubscribe | null = options.bindIpc(callback)
    let pushOff: Unsubscribe | null = null
    let statusOff: Unsubscribe | null = null
    let gone = false
    // Counts the push events delivered, so a catch-up read can tell whether
    // something newer arrived while it was out.
    let delivered = 0
    const bindIpc = (): void => {
      if (!ipcOff && !gone) ipcOff = options.bindIpc(callback)
    }
    const dropIpc = (): void => {
      ipcOff?.()
      ipcOff = null
    }
    const catchUp = (): void => {
      if (!options.catchUp) return
      const sentAt = delivered
      options.catchUp().then(
        (values) => {
          // Dropped when the listener is gone, or when an event of this tag
          // reached it meanwhile: that event is newer than this answer.
          if (gone || delivered !== sentAt) return
          for (const value of values) callback(value)
        },
        () => {
          // The read failed (a server that holds no such thing): the next
          // change arrives on the push channel.
        }
      )
    }
    const withdraw = options.onPush((push) => {
      if (gone) return
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
        if (value === undefined) return
        delivered += 1
        callback(value)
      })
      // The transport follows the socket: IPC while it is down, push while
      // it is open. The status callback runs in the welcome's own tick,
      // before any event frame, so the handover never doubles a delivery;
      // the catch-up read goes out in that same tick.
      statusOff = push.onStatus((status) => {
        if (status === 'open') {
          dropIpc()
          catchUp()
        } else bindIpc()
      })
      if (push.status === 'open') dropIpc()
    })
    return () => {
      gone = true
      withdraw()
      dropIpc()
      pushOff?.()
      statusOff?.()
    }
  }
}
