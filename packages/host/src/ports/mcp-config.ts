/**
 * The MCP config port: the per-session `--mcp-config` file a Claude session
 * is started with, which points the CLI at Clave's own MCP server with a
 * token of the session's own. The terminal backend asks for the file at
 * spawn and lets go of it on a real close; who writes it, where, and with
 * which token is the MCP server's business, behind this port (the app wires
 * `mcp-runtime.ts` in; a test hands a stand-in).
 */
export interface McpConfigPort {
  /** Wait for the shell's endpoint during boot. Refuse an unavailable shell
   *  after a bounded wait instead of starting an unbound Codex thread. */
  ready?(): Promise<void>
  /** The path of the session's config file, or null when there is no MCP
   *  server to point at: the spawn then omits the flag. */
  write(sessionId: string): string | null
  /** Forget the session's config. Nothing happens when there is none. */
  remove(sessionId: string): void
}

/** The in-app server and the attached shell both announce their endpoint
 * asynchronously. Each waiter owns its deadline and removes itself on expiry. */
export function mcpConfigReadiness(timeoutMs = 10_000): {
  ready(): Promise<void>
  announce(available: boolean): void
} {
  let available = false
  const waiters = new Set<() => void>()
  return {
    ready: () => {
      if (available) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          clearTimeout(timer)
          waiters.delete(finish)
          resolve()
        }
        const timer = setTimeout(() => {
          waiters.delete(finish)
          reject(
            new Error(
              'Clave MCP did not become available. Reopen this tab after the shell connects.'
            )
          )
        }, timeoutMs)
        waiters.add(finish)
      })
    },
    announce: (next) => {
      available = next
      if (available) for (const finish of waiters) finish()
    }
  }
}

/** A port with no MCP server behind it: every spawn omits the flag. */
export const noMcpConfig: McpConfigPort = {
  write: () => null,
  remove: () => {}
}
