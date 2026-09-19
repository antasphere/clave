import type { Terminal, ITheme } from '@xterm/xterm'

/**
 * Live xterm instances by session id. TerminalGrid keeps every local tab's
 * terminal mounted (hidden ones get display:none), so this registry gives
 * non-component code — the MCP dispatcher's clave_read_session — access to
 * any tab's rendered buffer without threading refs through the tree.
 */
const terminals = new Map<string, Terminal>()

export function registerTerminal(sessionId: string, terminal: Terminal): void {
  terminals.set(sessionId, terminal)
}

export function unregisterTerminal(sessionId: string, terminal: Terminal): void {
  // Only remove our own entry: StrictMode-style remount overlap must not let
  // an old instance's cleanup delete the new instance's registration.
  if (terminals.get(sessionId) === terminal) terminals.delete(sessionId)
}

export function getRegisteredTerminal(sessionId: string): Terminal | undefined {
  return terminals.get(sessionId)
}

declare global {
  interface Window {
    /** E2E seam, read-only: a hidden test window never syncs xterm's DOM
     *  viewport, so the specs assert a scroll against the MODEL's position —
     *  the same "assert Clave-internal state" rule as focus under
     *  --test-no-activate. */
    __claveTerminalTheme?: (sessionId: string) => ITheme | null
    __claveViewportY?: (sessionId: string) => number | null
  }
}
if (typeof window !== 'undefined') {
  window.__claveTerminalTheme = (sessionId: string): ITheme | null => {
    const terminal = terminals.get(sessionId)
    return terminal ? { ...terminal.options.theme } : null
  }
  window.__claveViewportY = (sessionId: string): number | null => {
    const t = terminals.get(sessionId)
    return t ? t.buffer.active.viewportY : null
  }
}
