import type { McpConfigPort } from './mcp-config'
import { settingsPorts } from './registry'
import type { StoragePort } from './storage'
import { nodePtyTerminals, type TerminalPort } from './terminal'

/**
 * The ports the terminal layer runs on: where its documents live (the tmux
 * config, the session records, the agent state files), how it gets a
 * process, and who writes a Claude session's MCP config.
 *
 * Resolved the way the settings ports are: named once at boot by whoever
 * composes the process (`installTerminalPorts`), looked up at every use.
 * Unnamed, the storage is the settings ports' own (inside Electron, the
 * app's data folder; a server names it first) and the terminals are
 * node-pty in this process. The MCP config has no safe default: a session
 * spawned before the app wired its MCP server in would start with no
 * `--mcp-config` and look fine, so an unnamed port refuses the write with
 * the fix named, and forgets nothing on a close.
 */
export interface TerminalPorts {
  storage: StoragePort
  terminals: TerminalPort
  mcpConfig: McpConfigPort
}

let installed: Partial<TerminalPorts> = {}
let defaultTerminals: TerminalPort | null = null

/** Name some or all of the ports; what is not named keeps its default. */
export function installTerminalPorts(ports: Partial<TerminalPorts>): void {
  installed = { ...installed, ...ports }
}

/** Forget the installed ports (tests). */
export function resetTerminalPorts(): void {
  installed = {}
  defaultTerminals = null
}

const unwiredMcpConfig: McpConfigPort = {
  write() {
    throw new Error(
      'No MCP config port installed: call installTerminalPorts({ mcpConfig }) before a Claude session is spawned.'
    )
  },
  remove() {
    // Nothing was written for the session, so there is nothing to forget.
  }
}

/** The ports in force, each resolved when it is read: asking for the MCP
 *  config port never resolves the storage, and the other way round. */
export function terminalPorts(): TerminalPorts {
  return {
    get storage() {
      return installed.storage ?? settingsPorts().storage
    },
    get terminals() {
      return installed.terminals ?? (defaultTerminals ??= nodePtyTerminals())
    },
    get mcpConfig() {
      return installed.mcpConfig ?? unwiredMcpConfig
    }
  }
}

/** The ports as the backend holds them: looked up at every use, so a test
 *  can swap them between cases and the app can wire them after the modules
 *  loaded. */
export const lazyTerminalPorts: TerminalPorts = {
  get storage() {
    return terminalPorts().storage
  },
  get terminals() {
    return terminalPorts().terminals
  },
  get mcpConfig() {
    return terminalPorts().mcpConfig
  }
}
