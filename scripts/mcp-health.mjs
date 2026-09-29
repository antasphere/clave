#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by hand from a tab */
// Is THIS tab's Clave MCP connection alive?
//
// Do NOT trust mcp-configs/<id>.json: Clave rewrites every surviving tab's
// config to the new URL at boot, so the file reads healthy while the running
// claude process still holds the pre-restart port in memory. The only honest
// signal is the tab's own MCP client log.
// Exits non-zero on failure so it can be used as a check, not a probe.
import { readFileSync, readdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const UD = join(homedir(), 'Library/Application Support/Clave')
const fail = (m) => {
  console.error(`DOWN: ${m}`)
  process.exit(1)
}

// 1. Is the server itself listening?
let live
try {
  live = JSON.parse(readFileSync(join(UD, 'mcp-server.json'), 'utf-8'))
} catch {
  fail('no mcp-server.json — Clave has never started an MCP server')
}
const res = await fetch(live.url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${live.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'health', version: '0' }
    }
  })
}).catch((e) => fail(`server not listening at ${live.url} (${e.cause?.code ?? e.message})`))
if (!res.ok) fail(`server at ${live.url} returned HTTP ${res.status}`)
const version = (await res.text()).match(/"version":"([^"]+)"/)?.[1] ?? '?'

// 2. Has THIS tab's client failed to reach it since?
const logDir = join(
  homedir(),
  'Library/Caches/claude-cli-nodejs',
  process.cwd().replace(/[/.]/g, '-'),
  'mcp-logs-clave'
)
if (!existsSync(logDir)) {
  console.log(`UP: clave ${version} at ${live.url} (no client log for this cwd yet)`)
  process.exit(0)
}
let last = null
for (const f of readdirSync(logDir).filter((f) => f.endsWith('.jsonl'))) {
  for (const l of readFileSync(join(logDir, f), 'utf-8').split('\n')) {
    if (!l.trim()) continue
    try {
      const d = JSON.parse(l)
      if (!last || d.timestamp > last.timestamp) last = d
    } catch {
      /* a line still being written: skip it */
    }
  }
}
if (last && /Unable to connect|Connection error/.test(last.debug ?? '')) {
  fail(
    `server is UP (clave ${version} at ${live.url}) but this tab cannot reach it — ` +
      `it holds a pre-restart endpoint. Last event ${last.timestamp}: "${last.debug}". ` +
      `Restart the tab; the connection cannot be re-pointed in place.`
  )
}
console.log(`UP: clave ${version} at ${live.url}; last client event ${last?.timestamp ?? 'n/a'} OK`)
