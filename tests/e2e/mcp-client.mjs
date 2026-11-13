/* A minimal Streamable-HTTP MCP client for the specs that call Clave's agent
   tools AS a tab: initialize once, then tools/call, with the tab's own bearer
   token. The same shape self-checkpoint.spec.mjs carried inline; shared here
   so a spec reads a tab's token off its mcp-config and speaks as that agent. */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export function mcpClient(url, token) {
  let mcpSessionId = null
  let nextId = 1
  const post = async (body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {})
      },
      body: JSON.stringify(body)
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) mcpSessionId = sid
    const text = await res.text()
    // The streamable transport may answer as SSE; the JSON-RPC payload rides
    // in `data:` lines. Parse both shapes.
    const payloads =
      text.startsWith('event:') || text.includes('\ndata:') || text.startsWith('data:')
        ? text
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
        : [text]
    const parsed = payloads.filter(Boolean).map((p) => JSON.parse(p))
    return parsed[parsed.length - 1] ?? null
  }
  return {
    async init() {
      const res = await post({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'clave-e2e', version: '0.0.0' }
        }
      })
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
      return res
    },
    async call(name, args) {
      return post({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    }
  }
}

/** The tool result's structured payload: structuredContent, else the text block parsed. */
export function toolPayload(rpc) {
  const r = rpc?.result
  if (!r) return null
  if (r.structuredContent) return r.structuredContent
  const text = r.content?.find((c) => c.type === 'text')?.text
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

/** The MCP endpoint of the app on `dir` and the per-tab token of `sessionId`,
 *  read off the files the app wrote: `mcp-server.json` and
 *  `mcp-configs/<sessionId>.json`. Null while either is not there yet. */
export function tabAgent(dir, sessionId, configDirs = [dir]) {
  const server = path.join(dir, 'mcp-server.json')
  // The terminal manager that writes the config runs where the sessions
  // live: the app's folder in-process, the separate server's attached.
  const config = configDirs
    .filter(Boolean)
    .map((d) => path.join(d, 'mcp-configs', `${sessionId}.json`))
    .find((f) => existsSync(f))
  if (!existsSync(server) || !config) return null
  const { url } = JSON.parse(readFileSync(server, 'utf-8'))
  const auth = JSON.parse(readFileSync(config, 'utf-8')).mcpServers?.clave?.headers?.Authorization
  const token = typeof auth === 'string' ? auth.replace(/^Bearer /, '') : null
  return url && token ? { url, token } : null
}
