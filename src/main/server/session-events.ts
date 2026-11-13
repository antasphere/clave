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
import type { SessionManager } from '../sessions/session-manager'
import type { LimitReport } from '../../shared/limit-report'
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

/** The session runs on `model` now (PRDCT-4256): the provider's own word,
 *  as `pty-manager` writes it to the record. Sent on BOTH transports from
 *  this one source, unlike the news above: the window's IPC channel at once
 *  (the session's window, by key) and the server's push channel when one
 *  publishes, and the window takes exactly one of them (the preload's dual
 *  listener, IPC until its push socket is welcomed, push from then on), so a
 *  switch made in a window's first seconds reaches its sidebar store too. */
export function sessionModelChanged(id: string, model: string): void {
  const windows = sessionWindows()
  windows.send(windows.windowOf(id), 'session:model-changed', { id, model })
  if (publisher)
    void publisher({ _tag: 'session.model_changed', id, model }).catch((error) =>
      console.error('[clave-server] session.model_changed not published', error)
    )
}

/** The session's CLI reported its account's limit, and which cap it hit
 *  (ADR 0002, PRDCT-4302). Both transports, from this one source, the way the
 *  model change goes: the window's IPC channel at once and the server's push
 *  channel when one publishes; the window takes exactly one of them. */
export function sessionLimitReported(id: string, report: LimitReport): void {
  const windows = sessionWindows()
  windows.send(windows.windowOf(id), 'session:limit-reported', { id, report })
  if (publisher)
    void publisher({ _tag: 'session.limit_reported', id, ...report }).catch((error) =>
      console.error('[clave-server] session.limit_reported not published', error)
    )
}

/** The account served the session a turn again after its limit report
 *  (PRDCT-4415): the window closes the report. Both transports, as the
 *  report goes. */
export function sessionLimitCleared(id: string): void {
  const windows = sessionWindows()
  windows.send(windows.windowOf(id), 'session:limit-cleared', { id })
  if (publisher)
    void publisher({ _tag: 'session.limit_cleared', id }).catch((error) =>
      console.error('[clave-server] session.limit_cleared not published', error)
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
