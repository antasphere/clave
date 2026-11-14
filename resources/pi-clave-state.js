/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Clave's bundled Pi extension. Pi loads this file with --extension, in a
// terminal tab and in a chat tab. Source contract: https://pi.dev/docs/extensions
//
// Three jobs, each switched on by a variable of the tab's own:
// - CLAVE_AGENT_STATE_FILE (terminal only): report the agent's state words.
// - CLAVE_MCP_CONFIG_FILE: register Clave's own tools for this session
//   (PRDCT-4507), read from the tab's own config file (mode 0600). The token
//   lives in that file alone: never in the environment, never on a command
//   line. Registrations are not saved by Pi: nothing is written anywhere.
// - CLAVE_CONNECTION_PROVIDER, CLAVE_CONNECTION_KEY_VAR (names) and
//   CLAVE_CONNECTION_REPORT_FILE: watch every provider request of a tab on a
//   stored connection (PRDCT-4540, `watchConnection`).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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
      // Every Clave tool reached one way, the one Pi's own prompt describes:
      // found with `tool_search`, then called. None is declared up front: a
      // split (some declared, the rest deferred) left Pi's prompt saying the
      // server's tools are not declared while some were, and the search never
      // returned those (a real model searched and never called them). The
      // whole list declared would weigh about 62 KB on every turn.
      exposure: 'deferred',
      description:
        'Clave, the app this tab runs in: its tabs listed, opened, read and messaged; a question, a value, a secret or an approval asked of the person; routines.'
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

const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** The api id of Pi's virtual models (Pi 1.5.2 `VIRTUAL_MODEL_API`, the test
 *  its own `isVirtualModel` makes). */
const VIRTUAL_MODEL_API = 'pi-virtual'

/** Whether the provider is Pi's own, as its catalog and `models.json` define
 *  it, with no extension registration over it. False when an extension
 *  registered that id, or when this Pi cannot say. */
function providerIsPis(registry, provider) {
  try {
    if (!registry || typeof registry.getRegisteredProviderIds !== 'function') return false
    const ids = registry.getRegisteredProviderIds()
    return Array.isArray(ids) && !ids.includes(provider)
  } catch {
    return false
  }
}

/** Where this provider request goes, against the tab's connection (Pi
 *  1.5.2's `before_provider_headers` sees no credential in its headers for an
 *  OpenAI-style provider, so the comparison is with what `getProviderAuth`
 *  resolves for the request's provider):
 *  - `on`: to the connection's provider, carrying the key of the variable named;
 *  - `provider`: to another provider;
 *  - `credential`: to the connection's provider with another credential (a
 *    `/login` in the tab, an OAuth sign-in);
 *  - `unchecked`: Pi gave no way to tell which credential (no
 *    `getProviderAuth`, or it threw), or the variable named holds no key
 *    in this process, or the model selected does not say where the request
 *    goes (below): not taken as the connection's.
 *  Compared in memory, never written, logged or sent. */
export async function requestOnConnection(ctx, provider, keyVar, env) {
  if (!ctx || !ctx.model) return 'provider'
  // A virtual model (Pi's `pi-virtual` api, docs/virtual-models.md) is a
  // SELECTION: listed under any provider id, the connection's included, it
  // routes each request to a physical model of its router's choosing, which
  // this hook is never shown (`ctx.model` stays the virtual one). Where the
  // request goes is unknown, whatever provider it is listed under.
  if (ctx.model.api === VIRTUAL_MODEL_API) return 'unchecked'
  if (ctx.model.provider !== provider) return 'provider'
  // The connection's provider registered again by an extension
  // (`pi.registerProvider`: another endpoint, its own models, its own stream)
  // sends wherever that registration says. Clave gives Pi its connections
  // through the agent directory's `models.json`, never through an extension,
  // so any registration under that id is someone else's.
  if (!providerIsPis(ctx.modelRegistry, provider)) return 'unchecked'
  // A connection with no key (a local model) names no variable: there is no
  // credential to compare, so it is watched by its provider alone.
  if (!keyVar) return 'on'
  const expected = env[keyVar]
  // A variable named but empty or absent leaves nothing to compare with.
  if (!expected) return 'unchecked'
  let resolved
  try {
    if (!ctx.modelRegistry || typeof ctx.modelRegistry.getProviderAuth !== 'function')
      return 'unchecked'
    resolved = await ctx.modelRegistry.getProviderAuth(provider)
  } catch {
    return 'unchecked'
  }
  const key = resolved && resolved.auth && resolved.auth.apiKey
  return typeof key === 'string' && key === expected ? 'on' : 'credential'
}

/** The report's line for an answer: an id and a word, never a value. */
export function connectionReportLine(answer, went) {
  const id = typeof went === 'string' && PROVIDER_RE.test(went) ? went : 'unknown'
  if (answer === 'on') return 'on'
  if (answer === 'credential') return `off ${id} credential`
  if (answer === 'unchecked') return `unchecked ${id}`
  return `off ${id}`
}

/**
 * PRDCT-4540: a tab on a stored connection is told two NAMES (the provider,
 * the variable its key rides in) and a report file. Before each provider
 * request the extension answers "does this request go on the connection?",
 * writes one line when the answer changes (`on`, `off <provider>`,
 * `off <provider> credential` or `unchecked <provider>`: an id and a word,
 * nothing else), and in a chat (`rpc`) ends a request that would leave the
 * connection before it is sent. A terminal is the person's own interface:
 * reported, never blocked. Never throws into Pi.
 */
export function watchConnection(pi, env) {
  const provider = env.CLAVE_CONNECTION_PROVIDER
  const reportFile = env.CLAVE_CONNECTION_REPORT_FILE
  if (!provider || !reportFile) return false
  const keyVar = env.CLAVE_CONNECTION_KEY_VAR
  let last = null
  const report = (line) => {
    if (line === last) return
    last = line
    try {
      mkdirSync(dirname(reportFile), { recursive: true })
      writeFileSync(reportFile, `${line}\n`, 'utf8')
    } catch {
      // Reporting is best effort; the chat's request is ended regardless.
    }
  }
  pi.on('before_provider_headers', async (_event, ctx) => {
    let answer = 'unchecked'
    try {
      answer = await requestOnConnection(ctx, provider, keyVar, env)
    } catch {
      answer = 'unchecked'
    }
    const went = ctx && ctx.model && ctx.model.provider
    report(connectionReportLine(answer, went))
    if (answer === 'on') return
    if (ctx && ctx.mode === 'rpc') {
      try {
        ctx.abort()
      } catch {
        // Nothing else to do: the adapter ends the turn on the report.
      }
    }
  })
  return true
}

export default function claveExtension(pi) {
  try {
    watchConnection(pi, process.env)
  } catch {
    // Never interrupt Pi.
  }
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
