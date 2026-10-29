/**
 * How a session's news reaches the windows: through the server's push channel
 * when a server publishes in this process (`session.title_changed`,
 * `session.plan_detected`, `session.cleared`, `session.state_changed`, every
 * attached client hears them), and over the per-window IPC channel it always
 * had when no server runs (the app without a server, the first moments of a
 * boot). One or the other, never both: the preload listens on both transports,
 * and a title delivered twice would rename a tab twice.
 *
 * The publisher is set by `clave-server.ts` when the in-process server starts
 * and cleared when it stops, and by the standalone entry for its own server;
 * an attached app's shell has none (the server is another process) and keeps
 * the IPC path. The window is named by its KEY and reached through the
 * session windows port (`sessions/windows.ts`): nothing here imports Electron.
 */
import type { ServerEvent } from '@clave/contract/events'
import type { NotifySignals } from '@clave/server'
import type { SessionManager } from '../sessions/session-manager'
import { sessionWindows } from '../sessions/windows'

type Publisher = (event: ServerEvent) => Promise<void>

let publisher: Publisher | null = null

export function setServerEventPublisher(next: Publisher | null): void {
  publisher = next
}

export function hasServerEventPublisher(): boolean {
  return publisher !== null
}

/** Publish on the server when it runs, else do what the shell always did. */
export function publishOrSend(event: ServerEvent, legacy: () => void): void {
  if (!publisher) return legacy()
  void publisher(event).catch((error) =>
    console.error(`[clave-server] ${event._tag} not published`, error)
  )
}

/** Every attached client hears a session change state, whether or not it
 *  follows that session's stream: the manager's state changes go out as
 *  `session.state_changed` on the publisher given. Returns the way to stop.
 *  The in-process entry and the standalone entry both wire it, once, when
 *  their server starts. */
export function publishSessionStates(
  manager: SessionManager,
  publish: (event: ServerEvent) => Promise<void>
): () => void {
  return manager.subscribeAll((id, stream) => {
    if (stream.kind !== 'event' || stream.event.type !== 'state_change') return
    void publish({ _tag: 'session.state_changed', id, state: stream.event.state }).catch((error) =>
      console.error('[clave-server] state event not published', error)
    )
  })
}

const send = (windowKey: string | null, channel: string, ...args: unknown[]): void =>
  sessionWindows().send(windowKey, channel, ...args)

/** The tab's name, earned from its first message. */
export function sessionTitleChanged(id: string, title: string, windowKey: string | null): void {
  publishOrSend({ _tag: 'session.title_changed', id, title }, () =>
    send(windowKey, `session:auto-title:${id}`, title)
  )
}

/** The agent wrote a plan at `path`. */
export function sessionPlanDetected(id: string, path: string, windowKey: string | null): void {
  publishOrSend({ _tag: 'session.plan_detected', id, path }, () =>
    send(windowKey, `session:plan-detected:${id}`, path)
  )
}

/** The conversation was cleared; the tab follows `providerSessionId` now. */
export function sessionCleared(
  id: string,
  providerSessionId: string | null,
  windowKey: string | null
): void {
  publishOrSend({ _tag: 'session.cleared', id, providerSessionId }, () =>
    send(windowKey, `session:clear-detected:${id}`, providerSessionId)
  )
}

// ── The mobile wave, lane B: what the notifier learns from where the sessions live ──

let initializeWrites: ((id: string) => void) | null = null

/** Establish an empty complete ledger only for a newly generated session id. */
export function initializeSessionWrites(id: string): void {
  initializeWrites?.(id)
}

let notifySignals: NotifySignals | null = null
/** The observation in force, so a quit can end it before the sessions go. */
let stopObservation: (() => void) | null = null
/** The sessions whose next exit a stop or a restart asked for: never a failure. */
const deliberateExits = new Set<string>()

/** End the observation: the app's quit calls it before it shuts its
 *  sessions down, so what a quit ends is never pushed as a failure. */
export function stopNotifyObservation(): void {
  stopObservation?.()
  stopObservation = null
}

/** The session's process is about to be ended on purpose (`lifecycle.ts`):
 *  its exit code, whatever it is, is not a failure to push. */
export function markDeliberateExit(id: string): void {
  deliberateExits.add(id)
}

/** A permission_response reached the session (`host.ts`): a push about that
 *  request that has not left yet is not sent. */
export function notifyRequestAnswered(sessionId: string, providerRequestId: string): void {
  notifySignals?.requestAnswered(sessionId, providerRequestId)
}

/**
 * Feed the notifier (`@clave/server`, the notify domain) what the server's
 * own events do not carry: every frame of every session's stream (a
 * permission_request where the server has no requests service, a fatal
 * error, the end of a turn) and every process exit with its code, said
 * deliberate when `markDeliberateExit` was called for it. Both entries wire
 * it once their server starts, beside `publishSessionStates`, and stop it
 * before their sessions are shut down, so a quit's exits push nothing.
 * Returns the way to stop.
 */
export function observeSessionsForNotify(
  manager: SessionManager,
  signals: NotifySignals,
  /** The server's own history of writes: a `user_message` carrying a client
   *  message id is recorded as it passes, the durable evidence that the
   *  provider took it (`packages/server/src/sessions/writes.ts`). */
  evidence?: (sessionId: string, clientMessageId: string, at: number) => void,
  initialize?: (sessionId: string) => void
): () => void {
  stopObservation?.()
  notifySignals = signals
  initializeWrites = initialize ?? null
  let stopped = false
  const offAll = manager.subscribeAll((id, stream) => {
    if (stopped || stream.kind !== 'event') return
    if (stream.event.type === 'user_message' && stream.event.clientMessageId !== undefined)
      evidence?.(id, stream.event.clientMessageId, Date.now())
    signals.streamEvent(id, stream.event)
  })
  const exits = new Map<string, () => void>()
  const watch = (id: string): void => {
    if (exits.has(id)) return
    try {
      exits.set(
        id,
        manager.subscribeExit(id, (code) => {
          const deliberate = deliberateExits.delete(id)
          exits.delete(id)
          if (!stopped) signals.exited(id, code, deliberate)
        })
      )
    } catch {
      // The session is gone already: nothing to watch.
    }
  }
  for (const session of manager.list()) watch(session.id)
  const offAdded = manager.subscribeAdded((session) => watch(session.id))
  const offRemoved = manager.subscribeRemoved((id) => {
    exits.get(id)?.()
    exits.delete(id)
    deliberateExits.delete(id)
  })
  const stop = (): void => {
    stopped = true
    if (notifySignals === signals) {
      notifySignals = null
      initializeWrites = null
    }
    if (stopObservation === stop) stopObservation = null
    offAll()
    offAdded()
    offRemoved()
    for (const off of exits.values()) off()
    exits.clear()
  }
  stopObservation = stop
  return stop
}
