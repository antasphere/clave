/**
 * The standalone server's session host (PRDCT-3293): the same host the app
 * runs (`host.ts`, over the session manager and the PTY lifecycle), built in
 * the server's own process. What differs is the ports under it, named here
 * once before any manager is touched: the terminal layer's documents (the
 * tmux config, the session records, the agent state, the test journal) live
 * under the server's `--data-dir`, a session's process comes from the
 * terminals port the entry provides (lane B's terminal process; `Terminals.none`
 * says what is missing until it exists, and a chat session, which runs the
 * CLI as a child process of its own, needs none), and no MCP server stands
 * behind the MCP config port, so a Claude session starts without
 * `--mcp-config` (the agent tools reach the server with lane D). The windows
 * are kept in memory: a window attached to this server reads a session's
 * bytes, title, plan and state off the push channel (`windows.ts`).
 *
 * The settings ports must be installed first (`standaloneSettingsSource`):
 * the launch profiles, the accounts and the workspaces the spawn reads
 * resolve through them. Nothing here imports Electron; the entry runs under
 * Bun.
 */
import type { AgentTokensService, SessionHostService, TerminalsService } from '@clave/server'
import * as path from 'path'
import { fileStorage, installTerminalPorts } from '../ports'
import { installE2eHooks } from './e2e-hooks'
import { getSessionHost } from './host'
import { type AgentTokenStore, createAgentTokenStore } from './agent-tokens'

export interface StandaloneHostOptions {
  /** The server's data directory, where the terminal layer keeps its files. */
  readonly dataDir: string
  /** Where a session's process comes from (the entry's terminals port). */
  readonly terminals: TerminalsService
}

export interface StandaloneSessionHost {
  readonly host: SessionHostService
  /** Wave 4, lane C: the agent tokens the server resolves, and whose
   *  `McpConfigPort` wrote the Claude session's config. The entry passes it
   *  as `ports.agentTools`; the attached shell announces its MCP address to
   *  it (`AnnounceAgentTools`), and until it does a Claude session starts
   *  with no `--mcp-config` (ADR 0003). */
  readonly agentTools: AgentTokensService
}

export function standaloneSessionHost(options: StandaloneHostOptions): StandaloneSessionHost {
  // The agent tools' tokens and the Claude session's config writer are one
  // store over the server's own `mcp-configs/` folder (`agent-tokens.ts`),
  // the standalone counterpart of the shell's MCP runtime.
  const tokens: AgentTokenStore = createAgentTokenStore(path.join(options.dataDir, 'mcp-configs'))
  installTerminalPorts({
    storage: fileStorage(options.dataDir),
    terminals: options.terminals,
    mcpConfig: tokens.mcpConfig
  })
  const host = getSessionHost()
  // The end-to-end seam, under the test flag only (`e2e-hooks.ts`): the
  // suite reaches this process through the server's fixture route and finds
  // the host where it finds the app's.
  installE2eHooks({ sessionHost: host })
  return { host, agentTools: tokens }
}
