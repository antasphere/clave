// Pinned to the in-process server (wave 2 of the server/client split,
// PRDCT-3239): this spec starts a session through the app, and a standalone
// server refuses every start until its terminal process exists (wave 3);
// the shared attached-mode fixture seam comes with it. Not a known failure.
/**
 * clave_open_session opens Claude and Codex in the chat view with chat: true.
 *
 * The chat view is a launch profile (`claude-chat`, `codex-chat`), and before
 * `chat` existed the only way to reach it through MCP was to already know that
 * id: an agent asked for "a chat session" told the user it could not be done.
 * So this goes through the real MCP endpoint, as an agent does — a parameter
 * missing from the tool's schema is stripped there without a word, and a call
 * that skipped the endpoint would pass on a tool no agent can use.
 *
 * Proven on the kernel's own record (adapter + transport), not on a tab name.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  spawnAgentTabIn,
  mcpHttpClient,
  mcpEndpoint,
  toolPayload,
  toolErrored,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'
import { mkdirSync } from 'node:fs'

const DIR = userDataDir('mcp-open-chat')
const ROOT = fixturePath('mcp-open-chat-root')
const WS = {
  id: 'dddddddd-0000-4000-8000-0000000000c7',
  name: 'Open chat',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR, { server: 'in-process' })
  try {
    const agent = await spawnAgentTabIn(app, win, DIR)
    t.check('an agent tab holds an MCP token', !!agent?.token, agent)
    const client = mcpHttpClient(mcpEndpoint(DIR), agent.token)
    await client.init()

    const kernel = async (id) =>
      until(async () =>
        (await win.evaluate(() => window.electronAPI.sessionsList())).find((s) => s.id === id)
      )

    // The tool tells an agent the chat view exists, where agents look.
    const tools = await fetch(mcpEndpoint(DIR), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${agent.token}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' })
    }).then((r) => r.text())
    t.check(
      'clave_open_session declares chat and names the chat view in its description',
      /"chat":\{[^}]*"type":"boolean"/.test(tools) && /CHAT VIEW/.test(tools),
      tools.slice(0, 200)
    )

    for (const [mode, adapterId] of [
      ['claude', 'claude-chat'],
      ['codex', 'codex-chat']
    ]) {
      const rpc = await client.call('clave_open_session', { cwd: ROOT, mode, chat: true })
      const opened = toolPayload(rpc)
      t.check(`${mode} chat: the call succeeds`, !toolErrored(rpc) && !!opened?.sessionId, rpc)
      const record = opened?.sessionId ? await kernel(opened.sessionId) : null
      t.check(
        `${mode} chat: the tab is a ${adapterId} events session, not a terminal`,
        record?.adapterId === adapterId && record?.transport === 'events',
        record
      )
    }

    const plain = toolPayload(
      await client.call('clave_open_session', { cwd: ROOT, mode: 'claude' })
    )
    const plainRecord = plain?.sessionId ? await kernel(plain.sessionId) : null
    t.check(
      'without chat, claude still opens in the terminal',
      plainRecord?.transport === 'pty',
      plainRecord
    )

    const refused = await client.call('clave_open_session', { cwd: ROOT, mode: 'pi', chat: true })
    t.check(
      'chat on a mode with no chat view is refused, not opened as a terminal',
      toolErrored(refused) && /no chat view/.test(JSON.stringify(refused)),
      refused
    )
  } finally {
    await app.close()
  }
}
