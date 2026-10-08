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
