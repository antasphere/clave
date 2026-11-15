// What a stand-in harness does with Clave's own tools when it was handed them
// (PRDCT-4507): it calls Clave's real tool server the way the real harness
// would, with exactly what the tab was given, and records what came back.
// Active only when `CLAVE_TOOLS_STAND_IN_LOG` names a file: one JSON line per
// call, never the token itself (whether it was found on argv or in a
// configuration, as booleans).
import { appendFileSync } from 'node:fs'

const LOG = process.env.CLAVE_TOOLS_STAND_IN_LOG

/** Post one JSON-RPC frame to a streamable-HTTP MCP endpoint; the last
 *  frame of an SSE answer, or the JSON body. */
function client(url, headers) {
  let mcpSessionId = null
  let id = 0
  const post = async (body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) mcpSessionId = sid
    if (!res.ok && res.status !== 202) throw new Error(`Clave MCP HTTP ${res.status}`)
    const text = await res.text()
    if (!text) return null
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
    return JSON.parse(data.length ? data[data.length - 1] : text)
  }
  return {
    async init() {
      await post({
        jsonrpc: '2.0',
        id: ++id,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'clave-stand-in', version: '0' }
        }
      })
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    },
    request: (method, params) => post({ jsonrpc: '2.0', id: ++id, method, params })
  }
}

function declared(tools, names) {
  const kept = Array.isArray(names) ? tools.filter((tool) => names.includes(tool.name)) : tools
  return {
    declaredTools: kept.map((tool) => tool.name),
    declaredBytes: JSON.stringify(kept).length
  }
}

/** Call `tools/list` and `clave_list` on the server described by `server`
 *  (`{ url, headers }`), and append what happened to the log with `facts`. */
export async function callClaveTools(server, facts) {
  if (!LOG) return
  const token = /^Bearer (.+)$/.exec(server?.headers?.Authorization ?? '')?.[1] ?? ''
  const base = {
    ...facts,
    envSessionId: process.env.CLAVE_SESSION_ID ?? null,
    tokenOnArgv: !!token && process.argv.some((arg) => arg.includes(token)),
    // The names of the variables holding the token, never their values.
    tokenInEnv: token
      ? Object.keys(process.env)
          .filter((name) => process.env[name]?.includes(token))
          .sort()
      : [],
    at: Date.now()
  }
  try {
    if (!server?.url || !token) throw new Error('No Clave server was handed over')
    const mcp = client(server.url, server.headers)
    await mcp.init()
    const tools = await mcp.request('tools/list', {})
    const listed = await mcp.request('tools/call', { name: 'clave_list', arguments: {} })
    const result = listed?.result
    const payload =
      result?.structuredContent ??
      JSON.parse(result?.content?.find((c) => c.type === 'text')?.text ?? 'null')
    appendFileSync(
      LOG,
      JSON.stringify({
        ...base,
        ok: true,
        tools: (tools?.result?.tools ?? []).map((tool) => tool.name),
        // What the declarations weigh, as a harness would hand them on.
        toolsBytes: JSON.stringify(tools?.result?.tools ?? []).length,
        // Those the harness declares to the model on every turn: the names
        // given (`declare`), or all of them; the rest are found by search.
        ...declared(tools?.result?.tools ?? [], facts.declare),
        callerSessionId: payload?.callerSessionId ?? null
      }) + '\n'
    )
  } catch (error) {
    appendFileSync(
      LOG,
      JSON.stringify({ ...base, ok: false, error: String(error?.message ?? error) }) + '\n'
    )
  }
}

/** Call one of Clave's tools as the tab, as a model would on a turn
 *  (PRDCT-4507: `clave-open {…}` typed into a stand-in chat): every call
 *  appended to the log as `{ kind: 'tool', name, ok, payload | error }`.
 *  Answers the same object. */
export async function callClaveTool(server, name, args) {
  let out
  try {
    if (!server?.url) throw new Error('No Clave server was handed over')
    const mcp = client(server.url, server.headers)
    await mcp.init()
    const answer = await mcp.request('tools/call', { name, arguments: args })
    const result = answer?.result
    const text = result?.content?.find((c) => c.type === 'text')?.text ?? 'null'
    let payload
    try {
      payload = result?.structuredContent ?? JSON.parse(text)
    } catch {
      payload = text
    }
    out = result?.isError
      ? { ok: false, error: typeof payload === 'string' ? payload : JSON.stringify(payload) }
      : { ok: true, payload }
  } catch (error) {
    out = { ok: false, error: String(error?.message ?? error) }
  }
  if (LOG)
    appendFileSync(
      LOG,
      JSON.stringify({
        kind: 'tool',
        name,
        args,
        envSessionId: process.env.CLAVE_SESSION_ID ?? null,
        at: Date.now(),
        ...out
      }) + '\n'
    )
  return out
}

/** The tool call a stand-in's prompt asks for, or null: `clave-open {…}`
 *  calls clave_open_session, `clave-call <tool> {…}` any other tool
 *  (PRDCT-4507: a tab renames itself with "mine"). Bad JSON is `args: null`. */
export function claveCallOf(text) {
  const open = text.startsWith('clave-open ') ? ['clave_open_session', text.slice(11)] : null
  const other = /^clave-call (clave_[a-z_]+) ([\s\S]*)$/.exec(text)
  const [name, raw] = open ?? (other ? [other[1], other[2]] : [null, null])
  if (!name) return null
  try {
    return { name, args: JSON.parse(raw) }
  } catch {
    return { name, args: null }
  }
}

/** Resolve OpenCode's `{env:NAME}` references in a string, as 2.3.0 does
 *  (an unset variable becomes empty). */
export function opencodeSubstitute(value) {
  return String(value).replace(
    /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_, name) => process.env[name] ?? ''
  )
}
