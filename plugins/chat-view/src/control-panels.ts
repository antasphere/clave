import { z } from 'zod'

/* What the /mcp and /plugin panels read off the CLI's control answers. The
   answers are the CLI's own shapes (Claude Code 2.1.304), read leniently: a
   field this build does not know is ignored, a server without a name is
   dropped, and an unknown state keeps its own word rather than a guess. */

export type McpServer = {
  name: string
  status: string
  scope: string | null
  /** The transport the server is reached over (stdio, http, sse, …). */
  transport: string | null
  /** How many tools it gives the agent; null when the CLI did not say. */
  tools: number | null
  error: string | null
}

const ServerSchema = z.object({
  name: z.string().min(1),
  status: z.string().catch('unknown'),
  scope: z.string().optional().catch(undefined),
  config: z.object({ type: z.string().optional() }).passthrough().optional().catch(undefined),
  tools: z.array(z.unknown()).optional().catch(undefined),
  error: z.string().optional().catch(undefined)
})

/** The servers of an `mcp_status` answer, in the order the CLI lists them. */
export function mcpServers(answer: Record<string, unknown>): McpServer[] {
  const list = Array.isArray(answer.mcpServers) ? answer.mcpServers : []
  return list.flatMap((raw) => {
    const server = ServerSchema.safeParse(raw)
    if (!server.success) return []
    const { name, status, scope, config, tools, error } = server.data
    return [
      {
        name,
        status,
        scope: scope ?? null,
        transport: config?.type ?? null,
        tools: tools ? tools.length : null,
        error: error ?? null
      }
    ]
  })
}

/** A record without one key: a row's error or busy mark, cleared. */
export function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const rest = { ...record }
  delete rest[key]
  return rest
}

const STATUS_LABELS: Record<string, string> = {
  connected: 'Connected',
  pending: 'Connecting',
  'needs-auth': 'Needs sign-in',
  failed: 'Failed',
  disabled: 'Disabled'
}
export const statusLabel = (status: string): string => STATUS_LABELS[status] ?? status

/** What the panel offers on a server, from its state alone. A disabled server
 *  is only switched back on; a server waiting on a sign-in is offered the
 *  sign-in rather than a reconnect it would fail; sign-out is for the remote
 *  transports, the only ones that carry a login. */
export function mcpActions(server: McpServer): {
  enabled: boolean
  authenticate: boolean
  reconnect: boolean
  clearAuth: boolean
} {
  const enabled = server.status !== 'disabled'
  const remote = server.transport === 'http' || server.transport === 'sse'
  return {
    enabled,
    authenticate: enabled && server.status === 'needs-auth',
    reconnect: enabled && server.status !== 'needs-auth',
    clearAuth: enabled && remote && server.status === 'connected'
  }
}

/** What a `reload_plugins` answer tells the reader: how much the session now
 *  carries, or why the reload did not apply. */
export function reloadSummary(answer: Record<string, unknown>): {
  text: string
  failed: boolean
} {
  if (answer.held === true)
    return { text: 'The reload was held back; the session keeps its plugins.', failed: true }
  const count = (key: string): number => (Array.isArray(answer[key]) ? answer[key].length : 0)
  const errors = typeof answer.error_count === 'number' ? answer.error_count : 0
  const many = (n: number, one: string, other: string): string => `${n} ${n === 1 ? one : other}`
  const loaded = `Reloaded: ${many(count('plugins'), 'plugin', 'plugins')}, ${many(count('commands'), 'command', 'commands')}, ${many(count('mcpServers'), 'MCP server', 'MCP servers')}`
  if (errors === 0) return { text: `${loaded}.`, failed: false }
  const first = Array.isArray(answer.errors) ? answer.errors[0] : undefined
  const detail =
    typeof first === 'string'
      ? first
      : first && typeof first === 'object' && 'message' in first
        ? String((first as { message: unknown }).message)
        : null
  return {
    text: `${loaded}, ${many(errors, 'error', 'errors')}${detail ? `: ${detail}` : ''}.`,
    failed: true
  }
}

/** The panels the host opens itself instead of sending the command to the
 *  agent: what the TUI shows as a menu, headless Claude cannot. */
export type HostPanel = 'resume' | 'mcp' | 'plugin'
const HOST_PANELS: Record<string, HostPanel> = {
  resume: 'resume',
  mcp: 'mcp',
  plugin: 'plugin',
  plugins: 'plugin'
}
/** The panel a slash command's name opens, if it is one of the host's. */
export const hostPanelOf = (name: string): HostPanel | null =>
  Object.hasOwn(HOST_PANELS, name) ? HOST_PANELS[name] : null
/** The panel a whole draft opens: the bare command only, so `/mcp` with
 *  arguments still goes to the CLI, which takes some of them headless. */
export function hostPanelFor(draft: string): HostPanel | null {
  const command = /^\/([\w-]+)\s*$/.exec(draft.trim())
  return command ? hostPanelOf(command[1]) : null
}
