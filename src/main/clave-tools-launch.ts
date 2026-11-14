import { readFileSync } from 'node:fs'
import path from 'node:path'
import { OPENCODE_CONFIG_ENV } from './provider-injection'
import { lazyTerminalPorts, unpackedPath } from './ports/terminals'

/**
 * Clave's own tools in a Pi or an OpenCode tab (PRDCT-4507). One issuer: the
 * tab's credential is the MCP config port's (`McpConfigPort.write(id)`), the
 * same file of the tab's own, mode 0600, a Claude tab is started with. Each
 * harness is then told about it its own way:
 *
 * - Pi: Clave's extension (`resources/pi-clave-state.js`) registers the
 *   server for the session, reading the file whose PATH is in
 *   `CLAVE_MCP_CONFIG_FILE`. The token stays in the file (checked on 1.5.2:
 *   `pi.registerMcpServer` at `session_start`, seven tools declared, the rest
 *   `deferred` behind `tool_search`).
 * - OpenCode: an `mcp.servers.clave` entry in the tab's inline configuration
 *   (`OPENCODE_CONFIG_CONTENT`) whose header names the token by reference,
 *   `{env:CLAVE_TAB_MCP_TOKEN}`, the value in the process's environment alone
 *   (checked on 2.3.0: substituted in a header, read by a standalone TUI and
 *   by `opencode acp`), reached through OpenCode's own code mode.
 *
 * Nothing is written to the person's own configuration of either harness.
 */

/** Clave's Pi extension, the one a Pi terminal starts with (`pty-backend`'s
 *  `piStateExtensionPath`, the same file): under the resources folder the
 *  entry named, unpacked from the asar when packaged. */
export function piClaveExtensionPath(): string {
  return unpackedPath(path.join(lazyTerminalPorts.resourcesDir, 'pi-clave-state.js'))
}

/** The variable holding the PATH of the tab's MCP config file (Pi). */
export const CLAVE_MCP_CONFIG_FILE_ENV = 'CLAVE_MCP_CONFIG_FILE'

/** The variable holding the tab's token for OpenCode's header. Credential-
 *  named (`TOKEN`), so every mask by name hides its value. */
export const CLAVE_TAB_MCP_TOKEN_ENV = 'CLAVE_TAB_MCP_TOKEN'

export interface ClaveMcpEndpoint {
  url: string
  token: string
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** The address and token of the tab's MCP config file, or null when there
 *  is no file (no tool server is up) or it is not the shape the issuer
 *  writes. Never throws: a tab starts without tools rather than not at all. */
export function readClaveMcpEndpoint(
  configPath: string | null | undefined
): ClaveMcpEndpoint | null {
  if (!configPath) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers
    const clave = (servers as { clave?: unknown } | null | undefined)?.clave as
      | { url?: unknown; headers?: unknown }
      | undefined
    const url = typeof clave?.url === 'string' ? clave.url : ''
    const authorization = (clave?.headers as { Authorization?: unknown } | undefined)?.Authorization
    const token =
      typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : ''
    if (!url || !token) return null
    const endpoint = new URL(url)
    if (!['http:', 'https:'].includes(endpoint.protocol)) return null
    if (endpoint.protocol === 'http:' && !LOCAL_HOSTS.has(endpoint.hostname)) return null
    return { url, token }
  } catch {
    return null
  }
}

/** OpenCode's `mcp.servers.clave` entry: the address, and the token by
 *  reference to the tab's own variable, never its value. */
export function opencodeClaveServer(url: string): Record<string, unknown> {
  return {
    type: 'remote',
    url,
    headers: { Authorization: `Bearer {env:${CLAVE_TAB_MCP_TOKEN_ENV}}` },
    // The header is the credential: no OAuth sign-in is ever started for it.
    oauth: false
    // No `codemode` key: OpenCode's own default, code mode, as for every
    // server a person registers there. Declaring all forty tools would add
    // about 62 KB to every turn (code mode adds about 4 KB: the server named
    // in a catalog, its tools found by search), and 2.3.0 sets this per
    // server only, so Pi's seven (CLAVE_DIRECT_TOOLS) cannot be split out.
  }
}

/** A tab's OpenCode environment with Clave's server added: the inline
 *  configuration it already has (a connection's, a model's) kept as it is,
 *  `mcp.servers.clave` added beside, and the token under its own variable.
 *  Unchanged when there is no endpoint. Pure. */
export function withOpencodeClaveTools(
  env: Readonly<Record<string, string>> | undefined,
  endpoint: ClaveMcpEndpoint | null
): Record<string, string> | undefined {
  if (!endpoint) return env ? { ...env } : undefined
  let config: Record<string, unknown> = {}
  const content = env?.[OPENCODE_CONFIG_ENV]
  if (content) {
    try {
      const parsed: unknown = JSON.parse(content)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        config = parsed as Record<string, unknown>
    } catch {
      // Not Clave's to repair: the tools go in a configuration of their own.
    }
  }
  const mcp =
    config.mcp && typeof config.mcp === 'object' ? (config.mcp as Record<string, unknown>) : {}
  const servers =
    mcp.servers && typeof mcp.servers === 'object' ? (mcp.servers as Record<string, unknown>) : {}
  // A server the person named `clave` in their own OpenCode configuration is
  // replaced by this one in a Clave tab: the inline configuration outranks
  // theirs, and the tab needs its own identity. Their other servers stay.
  const next = {
    ...config,
    mcp: { ...mcp, servers: { ...servers, clave: opencodeClaveServer(endpoint.url) } }
  }
  return {
    ...(env ?? {}),
    [OPENCODE_CONFIG_ENV]: JSON.stringify(next),
    [CLAVE_TAB_MCP_TOKEN_ENV]: endpoint.token
  }
}
