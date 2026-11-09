/**
 * Routines on a connected Clave server (PRDCT-4149): a `.clave` routine may
 * name the server that runs it; every server that reads the file lists it,
 * only the named one runs it, and the Mac shows that server's runs and
 * reports on its own toolbar. The toolbar has ONE Routines button (PRDCT-4244)
 * whose popover lists the routines in one section per machine (this Mac, each
 * connected server by its own name, a machine away); a row opens the panel.
 *
 * One standalone daemon started with `--server-name studio` (the fixture
 * `claude` and a login-shell stub on its PATH), one hidden in-process Mac
 * (`CLAVE_SERVER_NAME=macbook`). The SAME `.clave` file sits in both roots:
 * `Nightly on studio` (pinned, hourly) and `Local only` (unpinned, never due).
 * The Mac's clock is seeded so the pinned routine is ten hours overdue there.
 *
 *  1. the pin is decided per server: the Mac lists the pinned routine with
 *     `runsHere: false` and its next run, the daemon with `runsHere: true`,
 *     each listing naming its own server;
 *  2. the Mac never runs it: its ticks over an overdue occurrence start
 *     nothing, and Run now there is refused naming both servers;
 *  3. the daemon runs it: Run now ends ok with the fixture's report and a deck;
 *  4. the Mac shows the server's run: the pinned routine's row (under the
 *     Mac workspace that holds the same file) is the server's view, ok, in the
 *     `studio` section; the Mac's unpinned routine is in the `This Mac`
 *     section; the panel says `on studio` and shows the deck read over the
 *     API through `clave-preview://`, cached under the Mac's user data; the
 *     server workspace carries the server's unpinned routine in the `studio`
 *     section, not the pinned one twice;
 *  5. Run now in the panel runs on the server, never on the Mac;
 *  6. the server away: the row reads unreachable in an away section noted
 *     `Not connected`, says where it runs, and Run now is disabled.
 *
 * Fails if: a server runs a routine pinned elsewhere (by tick or by hand), the
 * listing loses `runsHere`/`server`, the Mac shows its own view while the
 * owner is connected, the remote deck is not read and cached, Run now is
 * routed to the Mac, or an unreachable owner leaves Run now enabled.
 */
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fleetWorld, connectMac, eventually, owned, step } from './fixtures/fleet-world.mjs'
import { fixturePath, seedTrustedRoots, seedWorkspaces, until } from './harness.mjs'

const BIN_ROOT = fixturePath('fleet-routines-bin')
const BIN = path.join(BIN_ROOT, 'bin')
const LOG = path.join(BIN_ROOT, 'claude.jsonl')
const CLAVE_REL = path.join('.clave', 'workspaces', 'default.clave')
const MINUTE_OF_HOUR = (new Date().getMinutes() + 30) % 60
const HOURLY = `${MINUTE_OF_HOUR} * * * *`
const NEVER = '0 0 31 2 *'
const HOUR = 3_600_000
const PINNED = 'Nightly on studio'
const LOCAL = 'Local only'
const HEADLINE = 'Fixture ok: all clean'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const INDEX = `<!doctype html><html><head><meta charset="utf-8"><title>Workspace health</title>
<script type="application/json" id="slideless-data">{}</script></head>
<body><h1 id="headline"></h1><script>
const d = JSON.parse(document.getElementById('slideless-data').textContent);
document.getElementById('headline').textContent = d.run ? d.run.headline : 'no data';
</script></body></html>`
const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['checks'],
  additionalProperties: false,
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'verdict'],
        properties: {
          name: { type: 'string' },
          verdict: { enum: ['ok', 'fixed', 'attention', 'failed'] }
        }
      }
    }
  }
}
const CLAVE_DOC = {
  groups: [
    {
      name: 'Ops',
      cwd: '.',
      toolbar: true,
      sessions: [],
      terminals: [],
      routines: [
        {
          name: PINNED,
          runsOn: 'studio',
          schedule: HOURLY,
          prompt: 'ROUTINE-MODE:ok Check the machine at @root_path.',
          // The built-in Claude, so the daemon runs the fixture `claude` on its
          // PATH rather than the fleet's default title profile.
          profile: 'builtin-claude',
          model: 'fixture-model',
          dangerousMode: true,
          icon: 'shield',
          color: 'teal',
          report: { template: '.clave/routines/health', width: 500, height: 400 }
        },
        {
          name: LOCAL,
          runsOn: 'every',
          schedule: NEVER,
          prompt: 'ROUTINE-MODE:ok Local.',
          model: 'fixture-model',
          dangerousMode: true,
          icon: 'bolt',
          color: 'blue'
        }
      ]
    }
  ]
}

/** The same `.clave` and template under a root. */
function writeTree(root) {
  mkdirSync(path.join(root, '.clave', 'workspaces'), { recursive: true })
  writeFileSync(path.join(root, CLAVE_REL), JSON.stringify(CLAVE_DOC))
  const folder = path.join(root, '.clave', 'routines', 'health')
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'index.html'), INDEX)
  writeFileSync(path.join(folder, 'schema.json'), JSON.stringify(SCHEMA))
  writeFileSync(path.join(folder, 'AGENT.md'), '# A fixture deck\n')
}

function seedBin() {
  rmSync(BIN_ROOT, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  // A login shell fixture keeps the stub-first PATH.
  writeFileSync(
    path.join(BIN, 'bash'),
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  // The fixture Claude, verbatim from routines.spec.mjs.
  writeFileSync(
    path.join(BIN, 'claude'),
    `#!${process.execPath}
const fs = require('node:fs'); const readline = require('node:readline');
const argv = process.argv.slice(2);
const LOG = ${JSON.stringify(LOG)};
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null };
if (!argv.includes('--session-id') && !argv.includes('--resume')) {
  process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('fixture title\\n'); process.exit(0) }); return;
}
const sid = at('--session-id') || at('--resume');
const cfgPath = at('--mcp-config');
let url = null, token = null;
try { const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); url = cfg.mcpServers.clave.url; token = cfg.mcpServers.clave.headers.Authorization.replace('Bearer ', '') } catch {}
fs.appendFileSync(LOG, JSON.stringify({ kind: 'spawn', sid, argv, cwd: fs.realpathSync(process.cwd()), hasMcp: !!url, pluginDir: at('--plugin-dir'), systemPrompt: at('--append-system-prompt'), model: at('--model'), dangerous: argv.includes('--dangerously-skip-permissions') || at('--permission-mode') === 'bypassPermissions', resume: at('--resume') }) + '\\n');
process.on('SIGTERM', () => process.exit(0));
const emit = (f) => process.stdout.write(JSON.stringify(f) + '\\n');
let rpc = 0;
async function tool(args) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name: 'clave_routine_report', arguments: args } }), signal: AbortSignal.timeout(8000) });
  const body = await res.text();
  const lines = body.split('\\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  const r = JSON.parse(lines.length ? lines.at(-1) : body);
  return r.result ?? r.error;
}
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let input; try { input = JSON.parse(line) } catch { return }
  if (input.type === 'control_request') {
    const sub = input.request && input.request.subtype;
    emit({ type: 'control_response', response: { subtype: 'success', request_id: input.request_id, response: sub === 'initialize' ? { models: [] } : {} } });
    return;
  }
  if (input.type !== 'user') return;
  const text = typeof input.message.content === 'string' ? input.message.content : JSON.stringify(input.message.content);
  fs.appendFileSync(LOG, JSON.stringify({ kind: 'message', sid, text }) + '\\n');
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sid, tools: [], mcp_servers: [], model: 'fixture-model', permissionMode: 'bypassPermissions', slash_commands: [], apiKeySource: 'none', claude_code_version: '2.1.278', uuid: 'u-' + sid });
  const mode = (/ROUTINE-MODE:(\\w+)/.exec(text) || [])[1] || 'none';
  try {
    if (url && mode !== 'silent' && mode !== 'none') {
      if (mode === 'retry') {
        const refused = await tool({ status: 'ok', headline: 'bad data', summary: 'bad', data: { checks: 'nope', extra: 1 } });
        fs.appendFileSync(LOG, JSON.stringify({ kind: 'refused', sid, result: refused }) + '\\n');
      }
      const ok = await tool({ status: 'ok', headline: 'Fixture ' + mode + ': all clean', summary: '# Done\\n\\nNothing to fix.', data: { checks: [{ name: 'steward status', verdict: 'ok' }] } });
      fs.appendFileSync(LOG, JSON.stringify({ kind: 'reported', sid, result: ok }) + '\\n');
    }
  } catch (error) { fs.appendFileSync(LOG, JSON.stringify({ kind: 'error', sid, error: String(error) }) + '\\n') }
  emit({ type: 'assistant', message: { id: 'm-' + sid, type: 'message', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: 'Reported.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }, session_id: sid, uuid: 'a-' + sid });
  emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: 'Reported.', session_id: sid, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, uuid: 'r-' + sid });
});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 }
  )
}

/** The Mac's scheduler store: the pinned routine last considered ten hours
 *  ago, so a tick that forgot the pin would run a catch-up at once. Keyed by
 *  the file path as written and as resolved (macOS /tmp is a link). */
function seedMacClock(dataDir, root) {
  const files = new Set([path.join(root, CLAVE_REL), path.join(realpathSync(root), CLAVE_REL)])
  const routines = {}
  for (const file of files)
    routines[`${file}::${PINNED}`] = {
      firstSeenAt: Date.now() - 11 * HOUR,
      lastSeenAt: Date.now(),
      lastConsideredAt: Date.now() - 10 * HOUR,
      schedule: HOURLY,
      runs: []
    }
  writeFileSync(
    path.join(dataDir, 'routines.json'),
    JSON.stringify({ version: 1, viewerPort: null, routines })
  )
}

const list = (fixture) =>
  fixture.evaluate(async () => {
    const r = globalThis.__claveE2E?.routines
    if (!r) throw new Error('no routines on the test hooks')
    return await r.list()
  })
const viewOf = (listing, name) => listing?.routines.find((v) => v.routine.name === name)
const runsOf = async (fixture, name) => viewOf(await list(fixture), name)?.runs ?? []
const ended = (run) => run && run.state !== 'running' && run.state !== 'waiting'
// The one Routines button, its popover's list, a routine's rows and their sections.
const LIST = '[data-testid="routines-list"]'
const ROW = (name) => `[data-testid="routine-row"][data-routine="${name}"]`
const rows = (win, name) => win.locator(`${LIST} ${ROW(name)}`)
/** The section holding a routine's row (the `has` locator is relative to the section). */
const sectionOf = (win, name, extra = '') =>
  win.locator(`${LIST} [data-testid="routines-section"]`).filter({
    has: win.locator(`${ROW(name)}${extra}`)
  })
/** Show the list: open the popover, or go back from a panel shown in it.
 *  Retried from a fresh click: a tab taking focus as it mounts can close the
 *  popover while it animates in. */
async function openList(win) {
  const list = win.locator(LIST)
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await list.isVisible()) return
    const back = win.locator('[data-testid="routine-back"]')
    if (await back.isVisible()) await back.click()
    else await win.locator('[data-testid="routines-button"]').click()
    if (
      await list.waitFor({ timeout: 1000 }).then(
        () => true,
        () => false
      )
    )
      return
  }
  await list.waitFor({ timeout: 5000 })
}
/** A row's attribute, the list opened first; null while it is not there. */
async function rowAttr(win, rowLocator, name) {
  await openList(win).catch(() => {})
  return await rowLocator.getAttribute(name, { timeout: 1000 }).catch(() => null)
}
/** Escape closes the popover; wait until it is gone before the next click. */
async function closePopover(win) {
  await win.keyboard.press('Escape')
  await win.locator(LIST).waitFor({ state: 'hidden', timeout: 5000 })
  await win.locator('[data-testid="routine-panel"]').waitFor({ state: 'hidden', timeout: 5000 })
}

async function closeSwitcher(win) {
  const add = win.getByRole('button', { name: 'Add workspace…', exact: true })
  if (await add.isVisible()) await win.keyboard.press('Escape')
  await add.waitFor({ state: 'hidden' })
}
async function switchTo(win, id) {
  await eventually(async () => {
    const target = win.locator(`[data-workspace-id="${id}"]`)
    if (!(await target.count())) {
      await win.getByLabel('Switch workspace', { exact: true }).click()
      await target.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {})
    }
    if (!(await target.count())) {
      await closeSwitcher(win)
      return false
    }
    if (
      (await target.getAttribute('data-selected', { timeout: 2_000 }).catch(() => null)) === 'true'
    ) {
      await closeSwitcher(win)
      return true
    }
    await target.click({ timeout: 3_000 }).catch(() => {})
    return false
  }, `the window shows workspace ${id}`)
}

export const deadlineMs = 8 * 60 * 1000

export async function run(t) {
  seedBin()
  const env = { PATH: `${BIN}:${process.env.PATH}`, SHELL: path.join(BIN, 'bash') }
  const world = await fleetWorld('fleet-routines', {
    count: 1,
    serverArgs: ['--server-name', 'studio'],
    env
  })
  const previousName = process.env.CLAVE_SERVER_NAME
  try {
    const [server] = world.servers
    writeTree(server.root)

    // The Mac, seeded here rather than by world.mac (which wipes its folder):
    // its workspace on the same tree, trusted, and its clock overdue.
    const macDir = fixturePath(`${world.run}-mac-a`)
    const macRoot = fixturePath(`${world.run}-local-a`)
    rmSync(macRoot, { recursive: true, force: true })
    mkdirSync(macRoot, { recursive: true })
    writeTree(macRoot)
    seedWorkspaces(macDir, {
      workspaces: [
        { id: 'mac-a', name: 'Mac a', rootDir: macRoot, profileFile: null, createdAt: 1 }
      ],
      activeWorkspaceId: 'mac-a',
      fresh: true
    })
    seedTrustedRoots(macDir, [macRoot])
    seedMacClock(macDir, macRoot)
    // The Mac's in-process server takes its name from the environment.
    process.env.CLAVE_SERVER_NAME = 'macbook'
    const mac = await world.mac('a', { reuse: macDir })
    const { win } = mac
    await connectMac(mac, world.servers, { ui: false })
    const owner = mac.owners[0].id

    // The server tree becomes a server workspace, trusted on the server.
    const serverWs = await win.evaluate(
      async ({ owner, root, fileKey, profileFile }) => {
        await window.electronAPI.trustWorkspaceRoot(fileKey)
        return window.electronAPI.fleetAddWorkspace(owner, {
          rootDir: root,
          name: 'Studio tree',
          profileFile
        })
      },
      {
        owner,
        root: server.root,
        fileKey: owned('file', owner, server.root),
        profileFile: path.join(server.root, CLAVE_REL)
      }
    )
    assert.ok(serverWs.id.startsWith('clave-owner:workspace:'), 'a remote workspace key')

    // ── 1. The pin is decided per server ──
    const [macListing, serverListing] = await step('the pin is decided per server', async () => {
      const m = await until(
        async () => {
          const l = await list(mac.fixture)
          return viewOf(l, PINNED) && viewOf(l, LOCAL) ? l : null
        },
        { tries: 120, gapMs: 250 }
      )
      const s = await until(
        async () => {
          const l = await list(server.fixture)
          return viewOf(l, PINNED) && viewOf(l, LOCAL) ? l : null
        },
        { tries: 120, gapMs: 250 }
      )
      assert.ok(m, 'the Mac lists both routines')
      assert.ok(s, 'the server lists both routines')
      return [m, s]
    })
    t.equal("the Mac's listing names the Mac", macListing.server?.name, 'macbook')
    t.equal(
      'on the Mac the pinned routine does not run here',
      viewOf(macListing, PINNED).routine.runsHere,
      false
    )
    t.equal(
      'on the Mac the routine is placed on studio (runsOn)',
      viewOf(macListing, PINNED).routine.runsOn,
      'studio'
    )
    t.check(
      'on the Mac the pinned routine still shows its next run',
      typeof viewOf(macListing, PINNED).nextRunAt === 'number',
      viewOf(macListing, PINNED).nextRunAt
    )
    t.equal(
      'on the Mac the unpinned routine runs here',
      viewOf(macListing, LOCAL).routine.runsHere,
      true
    )
    t.equal("the server's listing names the server", serverListing.server?.name, 'studio')
    t.equal(
      'on the server the pinned routine runs here',
      viewOf(serverListing, PINNED).routine.runsHere,
      true
    )

    // ── 2. The Mac never runs a pinned routine ──
    await step('the Mac never runs the pinned routine', async () => {
      // The boot tick has passed over a ten-hour-old clock; two more by hand.
      await mac.fixture.evaluate(async () => globalThis.__claveE2E.routines.tick())
      await sleep(500)
      await mac.fixture.evaluate(async () => globalThis.__claveE2E.routines.tick())
      await sleep(1500)
    })
    t.equal(
      'the Mac ticked over an overdue occurrence and ran nothing',
      (await runsOf(mac.fixture, PINNED)).length,
      0
    )
    // The seed reached the live routine (same key), so the ticks above did
    // face an overdue occurrence: without this the check would be vacuous.
    const macKey = viewOf(macListing, PINNED).routine.key
    const store = JSON.parse(readFileSync(path.join(macDir, 'routines.json'), 'utf8'))
    t.check(
      "the Mac's store holds the overdue clock under the live key",
      (store.routines?.[macKey]?.lastConsideredAt ?? Date.now()) < Date.now() - 9 * HOUR,
      { macKey, keys: Object.keys(store.routines ?? {}) }
    )
    const refusal = await mac.fixture.evaluate(async (k) => {
      try {
        await globalThis.__claveE2E.routines.runNow(k)
        return null
      } catch (error) {
        return String(error?.message ?? error)
      }
    }, viewOf(macListing, PINNED).routine.key)
    t.check(
      'Run now on the Mac is refused, naming studio and the Mac',
      !!refusal && refusal.includes('runs on studio') && refusal.includes('macbook'),
      refusal
    )
    t.equal('and the refusal started no run', (await runsOf(mac.fixture, PINNED)).length, 0)

    // ── 3. The server runs it ──
    const first = await step('the server runs the pinned routine', async () => {
      const key = viewOf(serverListing, PINNED).routine.key
      await server.fixture.evaluate(async (k) => {
        await globalThis.__claveE2E.routines.runNow(k)
      }, key)
      return await until(
        async () => {
          const runs = await runsOf(server.fixture, PINNED)
          return runs.length && ended(runs[0]) ? runs[0] : null
        },
        { tries: 240, gapMs: 500 }
      )
    })
    t.equal("the server's run ended ok", first?.state, 'ok')
    t.equal("with the fixture's headline", first?.headline, HEADLINE)
    t.check('and a deck', !!first?.deck, first)
    t.equal('the Mac still has no run of it', (await runsOf(mac.fixture, PINNED)).length, 0)

    // ── 4. The Mac shows the server's run ──
    await step("the Mac's toolbar shows the server's view of the pinned routine", async () => {
      await switchTo(win, 'mac-a')
      await eventually(
        async () => (await rowAttr(win, rows(win, PINNED), 'data-state')) === 'ok',
        'the pinned row reads ok from the server'
      )
    })
    const pinned = rows(win, PINNED)
    t.equal('the pinned routine has one row in the Mac workspace', await pinned.count(), 1)
    t.equal("the pinned row is the server's", await pinned.getAttribute('data-server'), owner)
    t.equal(
      'its section is the server, titled studio',
      await sectionOf(win, PINNED).getAttribute('data-machine'),
      'studio'
    )
    t.equal(
      'that section is a connected server',
      await sectionOf(win, PINNED).getAttribute('data-kind'),
      'server'
    )
    t.check(
      'its title says where it runs',
      /runs on studio/.test((await pinned.getAttribute('title')) ?? ''),
      await pinned.getAttribute('title')
    )
    const macLocal = rows(win, LOCAL)
    t.equal("the Mac's own unpinned routine is listed once", await macLocal.count(), 1)
    t.equal(
      "and it is the Mac's, with no server on its row",
      await macLocal.getAttribute('data-server'),
      null
    )
    t.equal(
      'it sits in the This Mac section, named by the Mac',
      await sectionOf(win, LOCAL, ':not([data-server])').getAttribute('data-machine'),
      'This Mac · macbook'
    )
    t.equal(
      'that section is this Mac',
      await sectionOf(win, LOCAL, ':not([data-server])').getAttribute('data-kind'),
      'here'
    )

    await pinned.click()
    const panel = win.locator(`[data-testid="routine-panel"][data-routine="${PINNED}"]`)
    await panel.waitFor({ timeout: 5000 })
    const schedule = await panel.locator('[data-testid="routine-panel-schedule"]').textContent()
    t.check('the panel says it runs on studio', /on studio/.test(schedule ?? ''), schedule)
    const src = await until(
      async () =>
        (await panel
          .locator('[data-testid="routine-report-deck"] webview')
          .getAttribute('src', { timeout: 1000 })
          .catch(() => null)) || null,
      { tries: 60, gapMs: 250 }
    )
    t.check(
      'the report deck is served through clave-preview://',
      /^clave-preview:\/\//.test(src ?? ''),
      src
    )
    const cacheRoot = path.join(mac.dir, 'routines', 'remote-decks')
    const cached = await until(() => {
      if (!existsSync(cacheRoot)) return null
      for (const s of readdirSync(cacheRoot))
        for (const r of readdirSync(path.join(cacheRoot, s))) {
          const f = path.join(cacheRoot, s, r, 'index.html')
          if (existsSync(f)) return f
        }
      return null
    })
    t.check(
      "the deck was read over the API and cached under the Mac's user data",
      !!cached && readFileSync(cached, 'utf8').includes(HEADLINE),
      cached
    )
    const shown = await until(
      () =>
        mac.app.evaluate(async ({ webContents }) => {
          const guest = webContents
            .getAllWebContents()
            .find((w) => w.getURL().startsWith('clave-preview://'))
          if (!guest) return null
          const text = await guest.executeJavaScript('document.documentElement.outerHTML')
          return text.includes('Fixture ok') ? true : null
        }),
      { tries: 60, gapMs: 250 }
    )
    t.check('the deck page in the guest holds the headline', !!shown)

    // ── 5. Run now goes to the server ──
    await step('Run now in the panel runs on the server', async () => {
      await panel.locator('[data-testid="routine-run-again"]').click()
      const runs = await until(
        async () => {
          const r = await runsOf(server.fixture, PINNED)
          return r.length >= 2 && ended(r[0]) ? r : null
        },
        { tries: 240, gapMs: 500 }
      )
      assert.ok(runs, 'the server recorded a second run')
      t.equal('the second run on the server ended ok', runs[0].state, 'ok')
      t.equal('a manual run', runs[0].trigger, 'manual')
    })
    t.equal('the Mac still ran nothing of it', (await runsOf(mac.fixture, PINNED)).length, 0)
    await closePopover(win)

    // The server workspace carries the server's own unpinned routine; the
    // pinned one is surfaced once, under the Mac workspace holding the file.
    await step("the server workspace shows the server's unpinned routine", async () => {
      await switchTo(win, serverWs.id)
      await eventually(
        async () => (await rowAttr(win, rows(win, LOCAL), 'data-server')) === owner,
        "the server's Local only shows in the server workspace"
      )
    })
    t.equal(
      'the pinned routine is not shown twice (no row of it in the server workspace)',
      await rows(win, PINNED).count(),
      0
    )
    // The every routine is listed by each machine that reads the file: the
    // Mac's copy was under This Mac in the Mac workspace (above); the server's
    // copy is here, under the server's own section. Both copies never meet in
    // one list in this spec: no combined pairing joins the two workspaces.
    const serverLocal = rows(win, LOCAL)
    t.equal("the server's Local only is listed once here", await serverLocal.count(), 1)
    t.equal(
      "the every routine is also listed under the server's section, titled studio",
      await sectionOf(win, LOCAL, `[data-server="${owner}"]`).getAttribute('data-machine'),
      'studio'
    )
    t.equal(
      'and that section is the connected server',
      await sectionOf(win, LOCAL, `[data-server="${owner}"]`).getAttribute('data-server'),
      owner
    )
    await closePopover(win)
    await switchTo(win, 'mac-a')

    // ── 6. The server away ──
    await step('the server away', async () => {
      await server.stop()
      await eventually(
        async () => (await rowAttr(win, rows(win, PINNED), 'data-state')) === 'unreachable',
        'the pinned row reads unreachable'
      )
    })
    const away = rows(win, PINNED)
    t.equal('the pinned routine still has one row', await away.count(), 1)
    const awaySection = sectionOf(win, PINNED)
    t.equal('its section is a machine away', await awaySection.getAttribute('data-kind'), 'away')
    t.equal(
      'the away section is titled by the server name',
      await awaySection.getAttribute('data-machine'),
      'studio'
    )
    t.equal(
      'the away section says Not connected',
      await awaySection.locator('[data-testid="routines-section-note"]').textContent(),
      'Not connected'
    )
    const title = (await away.getAttribute('title')) ?? ''
    t.check('its title says it runs on studio', title.includes('runs on studio'), title)
    t.check('and that studio is not connected', title.includes('not connected'), title)
    await away.click()
    await panel.waitFor({ timeout: 5000 })
    t.check(
      'Run now is disabled while the server is away',
      await panel.locator('[data-testid="routine-run-again"]').isDisabled()
    )
    await closePopover(win)
    t.check('no page error on the Mac', mac.errors.length === 0, mac.errors)
  } finally {
    if (previousName === undefined) delete process.env.CLAVE_SERVER_NAME
    else process.env.CLAVE_SERVER_NAME = previousName
    await world.close()
  }
}
