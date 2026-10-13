/**
 * The session windows port: what the session host still needs from the
 * windows, by window KEY and never by a window object. Inside the app the
 * shell implements it over its window registry and its IPC sends
 * (`electron-windows.ts`, installed by the PTY handlers at boot); the
 * standalone server keeps the bindings in memory and sends nothing, because
 * a window on the server reads a session's bytes, its title, its plan and a
 * cleared conversation off the push channel. The port is resolved on every
 * call, like the terminal ports, so the shell can install it after the
 * modules loaded and a test can swap it between cases.
 */

export interface SessionWindowsPort {
  /** The workspace the window of this key shows; null when the key names no
   *  live window, or when this host has no windows at all. */
  workspaceOf(windowKey: string): string | null
  /** The session belongs to the window from now on (the registry's binding,
   *  which the agent tools and the moves read). */
  bind(sessionId: string, windowKey: string): void
  unbind(sessionId: string): void
  /** The key of the window holding the session, null when none does. */
  windowOf(sessionId: string): string | null
  /** The per-window arm of what reaches a window directly: terminal bytes
   *  and exit, and a session's news when no server publishes them. A null
   *  key, a key naming no live window, or a host with no windows sends
   *  nothing. */
  send(windowKey: string | null, channel: string, ...args: unknown[]): void
  /** What a window must do before its session stops (a linked document it
   *  owns is flushed). Resolves at once when nothing is owed. */
  beforeStop(sessionId: string): Promise<void>
}

/** Bindings in memory, no window to send to: the standalone server's port,
 *  and the default until the shell installs its own. */
export function inMemorySessionWindows(): SessionWindowsPort {
  const hosts = new Map<string, string>()
  return {
    workspaceOf: () => null,
    bind: (sessionId, windowKey) => {
      hosts.set(sessionId, windowKey)
    },
    unbind: (sessionId) => {
      hosts.delete(sessionId)
    },
    windowOf: (sessionId) => hosts.get(sessionId) ?? null,
    send: () => {},
    beforeStop: () => Promise.resolve()
  }
}

let installed: SessionWindowsPort | null = null

/** Name the port; the shell does it once at boot. */
export function installSessionWindows(port: SessionWindowsPort | null): void {
  installed = port
}

/** The port in force, the in-memory one until the shell names its own. */
export function sessionWindows(): SessionWindowsPort {
  return (installed ??= inMemorySessionWindows())
}
