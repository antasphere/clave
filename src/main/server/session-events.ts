/**
 * How a session's news reaches the windows: through the server's push channel
 * when the in-process server runs (`session.title_changed`,
 * `session.plan_detected`, `session.cleared`, `session.state_changed`, every
 * attached client hears them), and over the per-window IPC channel it always
 * had when no server runs (the app without a server, the first moments of a
 * boot). One or the other, never both: the preload listens on both transports,
 * and a title delivered twice would rename a tab twice.
 *
 * The publisher is set by `clave-server.ts` when the server starts and
 * cleared when it stops; an attached server's shell has none (the server is
 * another process), so an attached app keeps the IPC path for these.
 */
import type { BrowserWindow } from 'electron'
import type { ServerEvent } from '@clave/contract/events'

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

const send = (win: BrowserWindow | null | undefined, channel: string, ...args: unknown[]): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

/** The tab's name, earned from its first message. */
export function sessionTitleChanged(id: string, title: string, win: BrowserWindow | null): void {
  publishOrSend({ _tag: 'session.title_changed', id, title }, () =>
    send(win, `session:auto-title:${id}`, title)
  )
}

/** The agent wrote a plan at `path`. */
export function sessionPlanDetected(id: string, path: string, win: BrowserWindow | null): void {
  publishOrSend({ _tag: 'session.plan_detected', id, path }, () =>
    send(win, `session:plan-detected:${id}`, path)
  )
}

/** The conversation was cleared; the tab follows `providerSessionId` now. */
export function sessionCleared(
  id: string,
  providerSessionId: string | null,
  win: BrowserWindow | null
): void {
  publishOrSend({ _tag: 'session.cleared', id, providerSessionId }, () =>
    send(win, `session:clear-detected:${id}`, providerSessionId)
  )
}
