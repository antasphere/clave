// Runs in both modes (wave 5, lane C, PRDCT-3433): the agent tools answer
// from the server since PRDCT-3377, and the tab's config is read from the
// folder of whichever server started the tab (the attached server's data
// directory, the app's own in-process).
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
  fixturePath,
  serverDataDirOf,
  recordsRootOf
} from './harness.mjs'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

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

  const { app, win } = await launchApp(DIR)
  try {
    const agent = await spawnAgentTabIn(app, win, serverDataDirOf(DIR))
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

    // The chat an agent opens is the chat the launcher would open: the
    // workspace's (here the global) default's chat form, not the built-in
    // chat whatever the person set. On 3 November 2026 a wave's Codex chats
    // ran on the built-in and asked before every command. Read off the
    // session record the server writes, the one a restart restores from.
    await win.evaluate(() =>
      window.electronAPI.launchProfileUpsert({
        id: 'yolo-e2e',
        name: 'yolo codex e2e',
        family: 'codex',
        command: ['codex', '--yolo'],
        additionalArgs: []
      })
    )
    await win.evaluate(() => window.electronAPI.launchProfileSetGlobal('codex', 'yolo-e2e'))
    const storedProfile = async (id) =>
      until(async () => {
        const file = path.join(recordsRootOf(DIR), 'session-records', `${id}.json`)
        if (!existsSync(file)) return null
        return JSON.parse(readFileSync(file, 'utf8')).launchProfileId ?? null
      })
    const onDefault = toolPayload(
      await client.call('clave_open_session', { cwd: ROOT, mode: 'codex', chat: true })
    )
    t.check(
      "codex chat with a saved profile as the default: the tab runs on that profile's chat form",
      onDefault?.sessionId
        ? (await storedProfile(onDefault.sessionId)) === 'chat:codex:yolo-e2e'
        : false,
      onDefault
    )
    const explicit = toolPayload(
      await client.call('clave_open_session', {
        cwd: ROOT,
        mode: 'codex',
        chat: true,
        profile: 'codex-chat'
      })
    )
    t.check(
      'the generic chat ID keeps the configured default with chat: true',
      explicit?.sessionId
        ? (await storedProfile(explicit.sessionId)) === 'chat:codex:yolo-e2e'
        : false,
      explicit
    )
    const successor = toolPayload(
      await client.call('clave_open_session', {
        cwd: ROOT,
        mode: 'codex',
        profile: 'codex-chat'
      })
    )
    t.check(
      'a successor opened with only the generic chat ID keeps the configured default',
      successor?.sessionId
        ? (await storedProfile(successor.sessionId)) === 'chat:codex:yolo-e2e'
        : false,
      successor
    )
    await win.evaluate(() =>
      window.electronAPI.launchProfileUpsert({
        id: 'strict-e2e',
        name: 'strict codex e2e',
        family: 'codex',
        command: ['codex', '-s', 'read-only', '-a', 'untrusted'],
        additionalArgs: []
      })
    )
    const custom = toolPayload(
      await client.call('clave_open_session', {
        cwd: ROOT,
        mode: 'codex',
        chat: true,
        profile: 'chat:codex:strict-e2e'
      })
    )
    t.check(
      'an explicitly named custom chat profile remains selectable',
      custom?.sessionId
        ? (await storedProfile(custom.sessionId)) === 'chat:codex:strict-e2e'
        : false,
      custom
    )
    await win.evaluate(() => window.electronAPI.launchProfileSetGlobal('codex', null))

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
