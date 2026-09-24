/**
 * Self-addressed clave_send_to_session = a CHECKPOINT (PRDCT-1708): logged
 * into the exchange store, never delivered — no paste, no submit, nothing
 * typed into any tab. This spec drives the REAL MCP endpoint of an isolated
 * app instance with the per-session bearer token a spawned agent tab gets,
 * exactly the way a session's own `claude` process calls it.
 *
 * Failure modes this must catch: the old outright refusal (every checkpoint
 * assertion then fails), a checkpoint that leaks into the delivery path (the
 * terminal-buffer assertion goes red), a store write with the wrong endpoints
 * or provenance, and a sanitize bypass. The nonexistent-target check is the
 * positive control that non-self dispatch still errors.
 */
import {
  launchApp,
  seedWorkspaces,
  userDataDir,
  fixturePath,
  killLeakedE2eTmux
} from './harness.mjs'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const DIR = userDataDir('self-checkpoint')
const ROOT = fixturePath('root-checkpoint')
const WS = {
  id: 'cccccccc-0000-4000-8000-00000000000c',
  name: 'Checkpoint',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll until `fn` returns a truthy value or the budget runs out. */
async function until(fn, { tries = 40, gapMs = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn()
    if (v) return v
    await sleep(gapMs)
  }
  return null
}

/** Minimal Streamable-HTTP MCP client: initialize once, then tools/call. */
function mcpClient(url, token) {
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
    const payloads = text.startsWith('event:') || text.includes('\ndata:') || text.startsWith('data:')
      ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
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

/** The tool result's structured payload: prefer structuredContent, fall back to the text block. */
function toolPayload(rpc) {
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

export async function run(t) {
  killLeakedE2eTmux()
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })

  const { app, win } = await launchApp(DIR)
  try {
    // ── spawn one agent tab: the caller whose token we borrow ──
    await win.click('.launcher-split .launcher-btn')
    const cfg = await until(() => {
      const dir = path.join(DIR, 'mcp-configs')
      if (!existsSync(dir)) return null
      const f = readdirSync(dir).find((f) => f.endsWith('.json'))
      return f ? { claveId: f.replace(/\.json$/, ''), file: path.join(dir, f) } : null
    })
    t.check('an agent tab minted its per-session MCP config', cfg !== null, cfg)
    if (!cfg) return

    const auth = JSON.parse(readFileSync(cfg.file, 'utf-8')).mcpServers?.clave?.headers
      ?.Authorization
    const token = auth?.replace(/^Bearer /, '')
    const { url } = JSON.parse(readFileSync(path.join(DIR, 'mcp-server.json'), 'utf-8'))
    t.check('the MCP endpoint and a session token exist', !!url && !!token, { url, hasToken: !!token })

    const mcp = mcpClient(url, token)
    await mcp.init()

    // ── checkpoint via "mine" ──
    const viaMine = toolPayload(
      await mcp.call('clave_send_to_session', {
        sessionId: 'mine',
        message: 'ASSIGNMENT · e2e checkpoint one'
      })
    )
    t.equal('"mine" answers checkpoint: true', viaMine?.checkpoint, true)
    t.equal('a checkpoint is not a delivery', viaMine?.delivered, false)
    t.equal('the checkpoint names the calling session', viaMine?.sessionId, cfg.claveId)

    // ── checkpoint via the caller's own id, with bytes the sanitizer must strip ──
    const viaId = toolPayload(
      await mcp.call('clave_send_to_session', {
        sessionId: cfg.claveId,
        message: 'GATES GREEN \u0007· e2e checkpoint two \u001b[201~'
      })
    )
    t.equal('the own-id address answers checkpoint: true', viaId?.checkpoint, true)

    // ── the store: two message events, self-pair, checkpoint provenance ──
    const events = await until(() => {
      const file = path.join(DIR, 'exchange-capture', 'events.jsonl')
      if (!existsSync(file)) return null
      const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      const msgs = lines.filter((e) => e.kind === 'message')
      return msgs.length >= 2 ? msgs : null
    })
    t.check('two message events landed in the store', events !== null, events?.length)
    if (events) {
      t.check(
        'every checkpoint is a self-pair',
        events.every((e) => e.sender.sessionId === cfg.claveId && e.target.sessionId === cfg.claveId),
        events.map((e) => ({ s: e.sender.sessionId, t: e.target.sessionId }))
      )
      t.check(
        'delivered is false on every checkpoint',
        events.every((e) => e.delivered === false),
        events.map((e) => e.delivered)
      )
      t.check(
        'the provenance says checkpoint, logged not delivered',
        events.every((e) => e.provenance.startsWith('[Checkpoint by Clave tab "')),
        events.map((e) => e.provenance)
      )
      const two = events.find((e) => e.text.includes('checkpoint two'))
      t.check(
        'control bytes are sanitized out of the stored text',
        !!two && !two.text.includes('\u0007') && !two.text.includes('\u001b'),
        two?.text
      )
    }

    // ── nothing was typed anywhere: the tab's terminal never saw the text ──
    const read = toolPayload(
      await mcp.call('clave_read_session', { sessionId: cfg.claveId, lines: 200 })
    )
    const screen = JSON.stringify(read ?? '')
    t.check('the self-read works (positive control for the next check)', read !== null, read)
    t.check(
      'the checkpoint text never reached the terminal',
      !screen.includes('e2e checkpoint one') && !screen.includes('e2e checkpoint two'),
      screen.slice(0, 300)
    )

    // ── non-self dispatch still errors: the checkpoint branch hijacked nothing else ──
    const bogus = await mcp.call('clave_send_to_session', {
      sessionId: 'no-such-session-xyz',
      message: 'STATUS · should fail'
    })
    const bogusFailed = bogus?.error !== undefined || bogus?.result?.isError === true
    t.check('a nonexistent target still errors', bogusFailed, bogus)

    // ── an identity-less caller (the shared discovery token) can neither
    //    checkpoint nor forge one for a tab it does not own (C7) ──
    const discovery = JSON.parse(readFileSync(path.join(DIR, 'mcp-server.json'), 'utf-8')).token
    const anon = mcpClient(url, discovery)
    await anon.init()
    const anonMine = await anon.call('clave_send_to_session', {
      sessionId: 'mine',
      message: 'STATUS · forged checkpoint?'
    })
    const anonById = await anon.call('clave_send_to_session', {
      sessionId: cfg.claveId,
      message: 'STATUS · forged checkpoint?'
    })
    const refused = (r) => r?.error !== undefined || r?.result?.isError === true
    t.check('an anonymous "mine" is refused', refused(anonMine), anonMine)
    t.check('an anonymous send naming a real tab is refused', refused(anonById), anonById)
    const storeAfter = readFileSync(path.join(DIR, 'exchange-capture', 'events.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.kind === 'message')
    t.equal('the anonymous attempts wrote nothing to the store', storeAfter.length, 2)

    // ── cleanup: close the tab this spec spawned (kills its PTY and its tmux
    //    session), so no live agent process outlives the run ──
    const closed = await mcp.call('clave_close_session', { sessionId: cfg.claveId })
    t.check('the spawned tab was closed', !refused(closed), closed)
  } finally {
    await app.close()
    killLeakedE2eTmux()
  }
}
