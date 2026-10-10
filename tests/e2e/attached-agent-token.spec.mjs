// An agent tab on the separate server reaches Clave's tools with its token
// (wave 4, lane C, PRDCT-3376). Attached, the session is the standalone
// server's: the server writes the tab's `--mcp-config` (pointing at the
// shell's MCP server, which the shell announced) and mints its per-session
// token; main's MCP server, which minted nothing for it, resolves the token
// through the server and lets the request in as that tab. In-process the same
// tab's config is main's own and resolves locally, so the same check holds
// in both modes.
//
// What makes it able to fail: drop the announce (`announceAgentToolsToServer`)
// and attached the server writes no config, so no token and the tab is cut
// off; drop main's `resolveAttachedToken` and the server's token is a 401;
// mint the config without a token and the shared discovery token is refused
// the identity-gated tools.
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  mcpEndpoint,
  mcpHttpClient,
  toolPayload,
  toolErrored,
  until
} from './harness.mjs'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = fixturePath('root-attached-agent-token')
const WS = {
  id: 'dddddddd-0000-4000-8000-00000000007c',
  name: 'Token',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

/** The mcp-config a freshly spawned agent tab minted, from wherever the
 *  terminal manager of this launch runs: the server's data folder attached,
 *  the app's own in-process. Returns { claveId, token } once it is there. */
async function spawnAgentTabAndToken(win, configsDir, before) {
  await win.click('.launcher-split .launcher-btn')
  return until(() => {
    if (!existsSync(configsDir)) return null
    const file = readdirSync(configsDir).find((f) => f.endsWith('.json') && !before.has(f))
    if (!file) return null
    const cfg = JSON.parse(readFileSync(path.join(configsDir, file), 'utf-8'))
    const auth = cfg.mcpServers?.clave?.headers?.Authorization
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null
    return { claveId: file.replace(/\.json$/, ''), token: auth.slice('Bearer '.length), url: cfg.mcpServers.clave.url }
  }, { tries: 80, gapMs: 250 })
}

async function checkMode(t, { label, dir, server }) {
  seedWorkspaces(dir, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(dir, [ROOT])
  const launched = await launchApp(dir, { server })
  const { app, win } = launched
  try {
    // The terminal manager that writes the config runs in the server attached,
    // in the app in-process; the folder follows it.
    const configsDir = path.join(launched.server?.dataDir ?? dir, 'mcp-configs')
    const before = new Set(existsSync(configsDir) ? readdirSync(configsDir) : [])
    const minted = await spawnAgentTabAndToken(win, configsDir, before)
    t.check(`${label}: the agent tab minted a config with a Bearer token`, !!minted, minted)
    if (!minted) return
    // The config points the CLI at the shell's MCP server (announced to the
    // standalone server attached), never at the standalone server itself.
    t.equal(`${label}: the config points at the shell's MCP endpoint`, minted.url, mcpEndpoint(dir))

    const mcp = mcpHttpClient(mcpEndpoint(dir), minted.token)
    await mcp.init()
    // An identity-gated tool: it answers only for a request whose token maps
    // to a tab. The shell minted nothing for this tab attached, so a pass
    // proves main resolved the token through the server.
    const listed = await mcp.call('clave_list', {})
    t.check(`${label}: the token is accepted (not refused)`, !toolErrored(listed), listed)
    const payload = toolPayload(listed)
    t.check(
      `${label}: and clave_list answers with this window's sessions`,
      !!payload && Array.isArray(payload.sessions),
      payload
    )
    // A wrong token is still refused: the resolve is not a blanket let-in.
    const wrong = mcpHttpClient(mcpEndpoint(dir), 'deadbeef'.repeat(8))
    const refused = await wrong.init().catch(() => ({ error: true }))
    t.check(`${label}: an unknown token is refused`, !!refused?.error || refused?.result === undefined, refused)
  } finally {
    await app.close()
  }
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  await checkMode(t, {
    label: 'attached',
    dir: userDataDir('attached-agent-token'),
    server: 'attached'
  })
  await checkMode(t, {
    label: 'in-process',
    dir: userDataDir('agent-token-in-process'),
    server: 'in-process'
  })
}
