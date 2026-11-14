/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Clave's bundled Pi extension. Pi loads this file with --extension, in a
// terminal tab and in a chat tab. Source contract: https://pi.dev/docs/extensions
//
// Two jobs, each switched on by a variable of the tab's own:
// - CLAVE_AGENT_STATE_FILE (terminal only): report the agent's state words.
// - CLAVE_MCP_CONFIG_FILE: register Clave's own tools for this session
//   (PRDCT-4507), read from the tab's own config file (mode 0600). The token
//   lives in that file alone: never in the environment, never on a command
//   line. Registrations are not saved by Pi: nothing is written anywhere.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The tools declared to the model on every turn; every other Clave tool is
 *  found through Pi's `tool_search` (`deferred`), as a Claude tab finds its
 *  deferred tools. The whole list weighs about 62 KB per turn otherwise. */
export const CLAVE_DIRECT_TOOLS = [
  'clave_list',
  'clave_launch_options',
  'clave_open_session',
  'clave_send_to_session',
  'clave_read_session',
  'clave_request_input',
  'clave_input_result'
]

/** The `clave` entry of the tab's MCP config file, as Pi's registration
 *  takes it, or null when the file is missing or not the expected shape. */
export function claveMcpServer(configFile) {
  try {
    const parsed = JSON.parse(readFileSync(configFile, 'utf8'))
    const entry = parsed && parsed.mcpServers && parsed.mcpServers.clave
    if (!entry || typeof entry.url !== 'string' || !entry.url) return null
    const headers = {}
    if (entry.headers && typeof entry.headers === 'object')
      for (const [name, value] of Object.entries(entry.headers))
        if (typeof value === 'string') headers[name] = value
    return {
      type: 'http',
      url: entry.url,
      headers,
      // Seven declared like `read` and `bash`; the rest found by search.
      exposure: 'deferred',
      toolExposure: Object.fromEntries(CLAVE_DIRECT_TOOLS.map((name) => [name, 'direct'])),
      description:
        'Clave, the app this tab runs in: its tabs listed, opened, read and messaged; a question, a value, a secret or an approval asked of the person; routines. Tools not declared here are found with tool_search.'
    }
  } catch {
    return null
  }
}

/** Whether something in this Pi connects MCP servers: the `/mcp` command is
 *  there (Pi's built-in support, or an extension that replaced it). Without
 *  it (`--no-mcp`, the built-in turned off) Pi would report the registration
 *  as an extension error to the person, so Clave registers nothing. */
function mcpIsOn(pi) {
  try {
    return typeof pi.getCommands === 'function' && pi.getCommands().some((c) => c.name === 'mcp')
  } catch {
    return false
  }
}

/** Register Clave's server for this session. Called at `session_start`, once
 *  Pi's runtime can answer `getCommands`; never throws. */
export function registerClaveTools(pi, configFile) {
  try {
    if (!configFile || typeof pi.registerMcpServer !== 'function') return false
    if (!mcpIsOn(pi)) return false
    const server = claveMcpServer(configFile)
    if (!server) return false
    pi.registerMcpServer('clave', server)
    return true
  } catch {
    // A name another extension holds, or an invalid config: Pi runs on
    // without Clave's tools. It must never interrupt the Pi session.
    return false
  }
}

export default function claveExtension(pi) {
  const configFile = process.env.CLAVE_MCP_CONFIG_FILE
  if (configFile) pi.on('session_start', () => registerClaveTools(pi, configFile))

  const stateFile = process.env.CLAVE_AGENT_STATE_FILE
  if (!stateFile) return

  const write = (state) => {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, state, 'utf8')
    } catch {
      // State reporting is optional. It must never interrupt the Pi session.
    }
  }

  pi.on('session_start', () => write('idle'))
  pi.on('before_agent_start', () => write('working'))
  pi.on('agent_start', () => write('working'))
  pi.on('agent_end', () => write('done'))
  pi.on('session_shutdown', () => write('ended'))
}
