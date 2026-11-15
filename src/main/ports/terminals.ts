import * as path from 'node:path'
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
 *
 * The resources folder (`resources/` of the checkout, or of the asar when
 * packaged) is where the files a session's command line points at live, Pi's
 * Clave extension first among them. Only an entry knows where it is: the
 * code that builds the command line sits in a bundle chunk, whose folder says
 * nothing about the app's root (PRDCT-4496). So the composer names it, the
 * Electron shell from its app path and the server from its own entry file,
 * and an unnamed port refuses the read with the fix named, like the MCP config.
 */
export interface TerminalPorts {
  storage: StoragePort
  terminals: TerminalPort
  mcpConfig: McpConfigPort
  /** The app's `resources` folder, as an absolute path (inside `app.asar`
   *  when packaged: a reader of an unpacked file maps it, `unpackedPath`). */
  resourcesDir: string
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
    },
    get resourcesDir() {
      if (installed.resourcesDir) return installed.resourcesDir
      throw new Error(
        'No resources folder installed: call installTerminalPorts({ resourcesDir }) from the entry before a Pi session is spawned.'
      )
    }
  }
}

/** The `resources` folder beside an entry file of the main process, from
 *  that entry's own `__dirname`. An entry sits two levels under the app's
 *  root in every layout: `src/main/` run from source, `out/main/` built,
 *  `app.asar/out/main/` packaged. Never call it from a module that a bundle
 *  can move into a chunk: only an entry's folder is fixed. */
export function resourcesDirOfEntry(entryDirname: string): string {
  return path.resolve(entryDirname, '..', '..', 'resources')
}

/** Where a file under `resources/` really is on disk: a packaged app unpacks
 *  `resources/**` beside the asar (`electron-builder.yml`, `asarUnpack`), and
 *  a program other than Electron (Pi, Claude) cannot read inside the asar. */
export function unpackedPath(p: string): string {
  return p.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked')
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
  },
  get resourcesDir() {
    return terminalPorts().resourcesDir
  }
}
