/**
 * The MCP config port: the per-session `--mcp-config` file a Claude session
 * is started with, which points the CLI at Clave's own MCP server with a
 * token of the session's own. The terminal backend asks for the file at
 * spawn and lets go of it on a real close; who writes it, where, and with
 * which token is the MCP server's business, behind this port (the app wires
 * `mcp-runtime.ts` in; a test hands a stand-in).
 */
export interface McpConfigPort {
  /** The path of the session's config file, or null when there is no MCP
   *  server to point at: the spawn then omits the flag. */
  write(sessionId: string): string | null
  /** Forget the session's config. Nothing happens when there is none. */
  remove(sessionId: string): void
}

/** A port with no MCP server behind it: every spawn omits the flag. */
export const noMcpConfig: McpConfigPort = {
  write: () => null,
  remove: () => {}
}
