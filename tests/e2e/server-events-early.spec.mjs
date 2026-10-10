// A window that binds its server-event listeners BEFORE main names the
// server still hears the server once it is up (wave 4, lane B, PRDCT-3295).
// Every family of listener (the workspace registry, the Claude and Codex
// accounts, the usage reads) used to ask the router once at bind time, be
// told null, and stay on IPC for the rest of the window's life; attached,
// main's IPC fan-out is main's own managers, so that window never heard a
// change the server made. The spec attaches the app to a server of its own
// whatever the suite's mode (in-process the shared instance's IPC fan-out
// hides the defect), makes the server come late through the harness's
// boot-delay seam, binds the listeners while there is none, then changes
// the server through its HTTP API and counts what the window heard.
//
// The login-progress and Antasphere families are pinned by the preload's
// unit test (`src/main/sessions/preload-server-events.test.ts`): a
// standalone server runs no login job, and a sign-in needs the OIDC fixture.
import { mkdirSync, rmSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  serverEndpoint,
  userDataDir,
  fixturePath,
  until
} from './harness.mjs'

const DIR = userDataDir('server-events-early')
const ROOT = fixturePath('server-events-early-root')
const WS = { id: 'sev-early-ws', name: 'Early', rootDir: ROOT, profileFile: null, createdAt: 1 }
const WS2 = { id: 'sev-early-ws2', name: 'Second', rootDir: ROOT, profileFile: null, createdAt: 2 }
const BOOT_DELAY_MS = 8000

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  // The server is started by the harness, but main names it to the window
  // only 8 s after boot; the window is driven 1.5 s after load.
  const { app, win, server, fixture } = await launchApp(DIR, {
    settleMs: 1500,
    server: 'attached',
    env: { CLAVE_E2E_SERVER_BOOT_DELAY_MS: String(BOOT_DELAY_MS) }
  })
  try {
    const api = async (method, path, body) => {
      const res = await fetch(server.url + path, {
        method,
        headers: {
          authorization: `Bearer ${server.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      })
      const text = await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : null }
    }
    const heard = () => win.evaluate(() => window.__early)

    const endpointNow = serverEndpoint(DIR)
    t.check('the window is driven before main named the server', endpointNow === null, endpointNow)

    await win.evaluate(() => {
      const early = (window.__early = {
        workspaces: [],
        claude: [],
        codex: [],
        claudeUsage: [],
        codexUsage: []
      })
      const api = window.electronAPI
      window.__earlyOff = [
        api.onWorkspaceStateChanged((s) => early.workspaces.push(s.workspaces.map((w) => w.id))),
        api.onClaudeAccountsChanged((a) => early.claude.push(a.map((x) => x.id))),
        api.onCodexAccountsChanged((a) => early.codex.push(a.map((x) => x.id))),
        api.onClaudeAccountUsage((u) => early.claudeUsage.push(u.accountId)),
        api.onCodexAccountUsage((u) => early.codexUsage.push(u.accountId))
      ]
    })
    const beforeServer = await heard()
    t.check(
      'nothing is heard while there is no server and nothing changes',
      Object.values(beforeServer).every((list) => list.length === 0),
      beforeServer
    )

    // The usage read on the server: the machine login's read goes to the
    // usage endpoint, answered here by a stubbed fetch in the server's own
    // process (the accounts spec's probe), so a forced read through the API
    // publishes `usage.claude_read` without reaching the network or a
    // keychain; whatever the read makes of the answer, it is published.
    await fixture.evaluate(() => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ five_hour: null, seven_day: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    })

    // The server comes: main names it, the preload's watch finds it within
    // two seconds, the socket is welcomed, and each listener reads the
    // server's state once (the catch-up) before any change is made.
    const caughtUp = await until(
      async () => {
        const h = await heard()
        return h.workspaces.length > 0 && h.claude.length > 0 && h.codex.length > 0 ? h : null
      },
      { tries: (BOOT_DELAY_MS + 8000) / 250, gapMs: 250 }
    )
    t.check(
      'once the server is named, each listener hears the server’s own state before any change',
      caughtUp !== null &&
        caughtUp.workspaces.length >= 1 &&
        caughtUp.claude.length >= 1 &&
        caughtUp.codex.length >= 1,
      caughtUp
    )
    t.check(
      'and that state is the server’s (the machine login the standalone lists)',
      caughtUp?.claude[0]?.includes('default') === true,
      caughtUp?.claude
    )
    const endpointAfter = serverEndpoint(DIR)
    t.check('main has named the server by then', endpointAfter?.url === server.url, endpointAfter)

    // The changes, each made on the server and never through the window;
    // each family counts from what the catch-up left it.
    const n0 = {
      workspaces: caughtUp.workspaces.length,
      claude: caughtUp.claude.length,
      codex: caughtUp.codex.length,
      claudeUsage: caughtUp.claudeUsage.length
    }
    const next = (family, n) =>
      until(
        async () => {
          const h = await heard()
          return h[family].length > n ? h[family] : null
        },
        { tries: 40, gapMs: 250 }
      )

    const registry = await api('POST', '/workspaces/registry', {
      workspaces: [WS, WS2],
      origin: 'e2e'
    })
    t.equal('the registry is written on the server', registry.status, 200)
    const workspaces = await next('workspaces', n0.workspaces)
    t.check(
      'the workspace listener bound before the server hears the registry change',
      Array.isArray(workspaces) && workspaces.at(-1)?.includes(WS2.id),
      workspaces
    )

    const added = await api('POST', '/accounts/claude', { label: 'Early' })
    t.equal('a Claude account is added on the server', added.status, 200)
    const claude = await next('claude', n0.claude)
    t.check(
      'the Claude accounts listener bound before the server hears the addition',
      Array.isArray(claude) && claude.at(-1)?.includes(added.body.id),
      claude
    )

    const codex = await api('POST', '/accounts/codex', { label: 'Early codex' })
    t.equal('a Codex account is added on the server', codex.status, 200)
    const codexHeard = await next('codex', n0.codex)
    t.check(
      'the Codex accounts listener bound before the server hears the addition',
      Array.isArray(codexHeard) && codexHeard.at(-1)?.includes(codex.body.id),
      codexHeard
    )

    const forced = await api('GET', '/usage/claude?accountId=default&force=true')
    t.equal('the machine login’s usage is read on the server', forced.status, 200)
    const usage = await next('claudeUsage', n0.claudeUsage)
    t.check(
      'the usage listener bound before the server hears the read',
      Array.isArray(usage) && usage.at(-1) === 'default',
      usage
    )

    // Each change once: the IPC listener was dropped at the welcome.
    await win.waitForTimeout(1500)
    const all = await heard()
    t.equal('the registry change was heard once', all.workspaces.length, n0.workspaces + 1)
    t.equal('the Claude addition was heard once', all.claude.length, n0.claude + 1)
    t.equal('the Codex addition was heard once', all.codex.length, n0.codex + 1)
    t.equal('the usage read was heard once', all.claudeUsage.length, n0.claudeUsage + 1)
    await win.evaluate(() => {
      for (const off of window.__earlyOff) off()
    })
  } finally {
    await app.close()
  }
}
