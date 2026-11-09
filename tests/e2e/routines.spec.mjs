/**
 * Routines (ADR 0004): a `.clave` group schedules agent sessions the server
 * runs by itself; the run reports through `clave_routine_report`; the toolbar
 * carries the badge and the floating panel.
 *
 * Real hidden Electron, a fixture `claude` binary that speaks stream-json and
 * calls the real Clave MCP endpoint its `--mcp-config` names, and the real
 * scheduler driven by its clock: the store is seeded with a routine last
 * considered ten minutes ago, so the FIRST tick finds ten missed occurrences
 * and runs ONE catch-up. The scheduler's own rules have unit tests
 * (`src/main/routines/*.test.ts`); this spec proves the path through the app:
 *
 *  1. the catch-up fires once as declared (model, permissions off, the
 *     contract plugin, the first message), the fixture reports through the
 *     tool, the deck is written from the template with the data, the badge
 *     reads ok and the panel shows the headline; Dismiss puts the dot away;
 *  2. an occurrence another server claimed is not run here (machine scope);
 *  3. a run that ends without a report is failed, with the reason;
 *  4. data the schema refuses is answered to the agent with the errors, and
 *     the corrected call lands;
 *  5. a `team` routine is listed as unable to run, never run;
 *  6. the Discussion toggle mounts the chat view on the run's conversation;
 *  7. a relaunch with a missed occurrence catches up exactly once more.
 * Each of these goes red on its own when its rule is removed.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  separateServerDataDir,
  serverMode,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('routines')
const ROOT = fixturePath('routines-root')
const BIN = path.join(ROOT, 'bin')
const LOG = path.join(ROOT, 'claude.jsonl')
const CLAVE = path.join(ROOT, '.clave', 'workspaces', 'default.clave')
const WS = { id: 'routines-ws', name: 'Routines', rootDir: ROOT, profileFile: CLAVE, createdAt: 1 }
// The server's data directory: the app's own in-process, its child's otherwise.
const DATA = serverMode() === 'in-process' ? DIR : separateServerDataDir(DIR)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
// Hourly, at the minute half an hour from now: the latest occurrence is always
// about thirty minutes old, so a run for it is a catch-up, never on time; and
// nothing fires by itself during the test. The manual routines never come.
const MINUTE_OF_HOUR = (new Date().getMinutes() + 30) % 60
const HOURLY = `${MINUTE_OF_HOUR} * * * *`
const NEVER = '0 0 31 2 *'

const key = (name) => `${CLAVE}::${name}`
const hashKey = (k) => createHash('sha256').update(k).digest('hex').slice(0, 24)
const log = () =>
  existsSync(LOG)
    ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []
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

function template(name) {
  const folder = path.join(ROOT, '.clave', 'routines', name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'index.html'), INDEX)
  writeFileSync(path.join(folder, 'schema.json'), JSON.stringify(SCHEMA))
  writeFileSync(path.join(folder, 'AGENT.md'), '# A fixture deck\n')
}

const routine = (name, mode, extra = {}) => ({
  name,
  schedule: NEVER,
  prompt: `ROUTINE-MODE:${mode} Check the machine at @root_path. {{extra}}`,
  params: { extra: 'Be brief.' },
  model: 'fixture-model',
  dangerousMode: true,
  icon: 'shield',
  color: 'teal',
  report: { template: '.clave/routines/health', width: 500, height: 400 },
  runsOn: 'every',
  ...extra
})

function seedFixture() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  mkdirSync(path.dirname(CLAVE), { recursive: true })
  template('health')
  writeFileSync(
    CLAVE,
    JSON.stringify({
      groups: [
        {
          name: 'Ops',
          cwd: '.',
          toolbar: true,
          sessions: [],
          terminals: [],
          routines: [
            routine('Workspace health', 'ok', { schedule: HOURLY }),
            routine('Claimed elsewhere', 'ok', { schedule: HOURLY }),
            routine('Silent', 'silent'),
            routine('Retry', 'retry'),
            routine('Team job', 'ok', { scope: 'team' })
          ]
        }
      ]
    })
  )
  // A login shell fixture keeps the stub-first PATH.
  writeFileSync(
    path.join(BIN, 'bash'),
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  // The fixture Claude: a title one-shot answers a line; a session reads its
  // first user message, reports through the Clave MCP endpoint its
  // --mcp-config names (unless the job says ROUTINE-MODE:silent; a retry job
  // sends invalid data first), then ends its turn with a result frame.
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

/** The scheduler's store: a routine last considered `agoMs` ago, so the first
 *  tick finds the occurrences since then. */
function seedClock(names, agoMs) {
  const file = path.join(DATA, 'routines.json')
  const doc = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { version: 1, viewerPort: null, routines: {} }
  for (const name of names) {
    const state = doc.routines[key(name)] ?? {
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      runs: []
    }
    doc.routines[key(name)] = {
      ...state,
      lastConsideredAt: Date.now() - agoMs,
      schedule: HOURLY,
      lastSeenAt: Date.now()
    }
  }
  mkdirSync(DATA, { recursive: true })
  writeFileSync(file, JSON.stringify(doc))
}

/** Claims held by "another server" for every occurrence around now. */
function seedClaims(name, fromMs, toMs) {
  const folder = path.join(DATA, 'routine-claims', hashKey(key(name)))
  mkdirSync(folder, { recursive: true })
  const start = new Date(fromMs)
  start.setMinutes(MINUTE_OF_HOUR, 0, 0)
  for (let t = start.getTime(); t <= toMs; t += HOUR)
    writeFileSync(
      path.join(folder, `${t}.json`),
      JSON.stringify({
        routineKey: key(name),
        occurrence: t,
        holder: 'another-server',
        at: Date.now()
      })
    )
}

const listRoutines = (fixture) =>
  fixture.evaluate(async () => {
    const r = globalThis.__claveE2E?.routines
    if (!r) throw new Error('no routines on the test hooks')
    return await r.list()
  })
const runsOf = async (fixture, name) =>
  (await listRoutines(fixture)).routines.find((v) => v.routine.name === name)?.runs ?? []
const ended = (run) => run && run.state !== 'running' && run.state !== 'waiting'

export async function run(t) {
  seedFixture()
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  // Ten minutes of missed occurrences for the two scheduled routines; the
  // claimed one has every occurrence taken by another server already.
  seedClock(['Workspace health', 'Claimed elsewhere'], 10 * HOUR)
  seedClaims('Claimed elsewhere', Date.now() - 12 * HOUR, Date.now() + 3 * HOUR)

  const env = { SHELL: path.join(BIN, 'bash'), PATH: `${BIN}:${process.env.PATH}` }
  let { app, win, fixture } = await launchApp(DIR, { env })
  let first = null
  try {
    // ── 1. The catch-up fires once, as declared, and reports ──
    first = await until(
      async () => {
        const runs = await runsOf(fixture, 'Workspace health')
        return runs.length && ended(runs[0]) ? runs : null
      },
      { tries: 240, gapMs: 500 }
    )
    assert.ok(first, 'the catch-up run of Workspace health ended')
    t.equal('ten missed occurrences made ONE catch-up run', first.length, 1)
    t.equal('the run is a catch-up', first[0].trigger, 'catch-up')
    t.equal('the run ended ok from the report', first[0].state, 'ok')
    t.equal("the headline is the report's", first[0].headline, 'Fixture ok: all clean')
    t.equal('the run ran on the declared model', first[0].model, 'fixture-model')
    t.check(
      'the run names its session and the provider conversation',
      !!first[0].sessionId && !!first[0].providerSessionId,
      first[0]
    )

    const spawns = log().filter((e) => e.kind === 'spawn')
    const spawn = spawns.find((e) => e.sid === first[0].providerSessionId) ?? spawns[0]
    t.check(
      'the CLI got --mcp-config, so the report tool was reachable',
      spawn?.hasMcp === true,
      spawn
    )
    t.check(
      'the CLI got the contract plugin folder',
      /claude-plugins\/clave-routine$/.test(spawn?.pluginDir ?? ''),
      spawn?.pluginDir
    )
    t.check(
      'the CLI got the one-line system prompt naming the contract',
      /clave-routine:run/.test(spawn?.systemPrompt ?? ''),
      spawn?.systemPrompt
    )
    t.check(
      'permissions were off as declared (the chat form takes the bypass mode)',
      spawn?.dangerous === true,
      spawn
    )
    t.equal('the model flag is the declared one', spawn?.model, 'fixture-model')
    t.equal('the run worked in the routine cwd', spawn?.cwd, realpathSync(ROOT))
    const message = log().find((e) => e.kind === 'message' && e.sid === spawn?.sid)
    t.check(
      'the first message invokes the contract skill with the facts',
      /^\/clave-routine:run Routine: Workspace health\nRun: /.test(message?.text ?? ''),
      message?.text?.slice(0, 120)
    )
    t.check(
      'the first message names the schema file',
      (message?.text ?? '').includes(
        `Schema: ${path.join(ROOT, '.clave', 'routines', 'health', 'schema.json')}`
      ),
      message?.text
    )
    t.check(
      'the job is the prompt with its params and tokens substituted',
      (message?.text ?? '').includes(
        `Job:\nROUTINE-MODE:ok Check the machine at ${ROOT}. Be brief.`
      ),
      message?.text
    )

    const deckFile = path.join(DATA, 'routines', 'decks', path.dirname(first[0].deck), 'data.json')
    t.check('the deck was written from the template with data.json', existsSync(deckFile), deckFile)
    const envelope = existsSync(deckFile) ? JSON.parse(readFileSync(deckFile, 'utf8')) : null
    t.equal('the envelope carries the headline', envelope?.run?.headline, 'Fixture ok: all clean')
    t.equal('the envelope carries the agent data', envelope?.data?.checks?.[0]?.verdict, 'ok')
    const deckHtml = path.join(DATA, 'routines', 'decks', first[0].deck)
    t.check(
      'the page block holds the envelope',
      existsSync(deckHtml) &&
        readFileSync(deckHtml, 'utf8').includes('"headline": "Fixture ok: all clean"'),
      deckHtml
    )

    // The badge: ok and unseen.
    const button = win.locator('[data-testid="routine-button"][data-routine="Workspace health"]')
    await until(async () => (await button.getAttribute('data-state')) === 'ok', { tries: 40 })
    t.equal('the toolbar button reads ok', await button.getAttribute('data-state'), 'ok')
    t.equal(
      'the badge dot is there while unseen',
      await button.locator('[data-testid="routine-dot"]').count(),
      1
    )
    await button.click()
    const panel = win.locator('[data-testid="routine-panel"][data-routine="Workspace health"]')
    await panel.waitFor({ timeout: 5000 })
    t.check(
      'the panel shows the headline (the envelope card, no viewer here)',
      (await panel.locator('[data-testid="routine-report-headline"]').textContent()) ===
        'Fixture ok: all clean'
    )
    t.check(
      'the panel names the schedule in words',
      /every hour at minute/.test(
        await panel.locator('[data-testid="routine-panel-schedule"]').textContent()
      )
    )
    // Dismiss and Open as a tab live in the panel's small menu, behind More.
    await panel.locator('[data-testid="routine-more"]').click()
    await panel.locator('[data-testid="routine-dismiss"]').click()
    await until(async () => (await button.getAttribute('data-state')) === 'seen', { tries: 40 })
    t.equal(
      'Dismiss puts the dot away',
      await button.locator('[data-testid="routine-dot"]').count(),
      0
    )

    // ── 6. Discussion: the chat view on the run's conversation, in the panel ──
    await panel.locator('[data-testid="routine-tab-discussion"]').click()
    const discussion = await until(
      () => win.locator('[data-testid="routine-discussion"] [data-testid="chat-view"]').count(),
      { tries: 60, gapMs: 500 }
    )
    t.check('the Discussion toggle mounts the chat view inside the panel', !!discussion)
    // The discussion is a new process on the run's own conversation id: resumed
    // when the transcript exists, started again under the same id here (the
    // fixture writes no transcript); either way the second spawn of that id,
    // waited for (the fixture logs it a moment after the chat view mounts).
    const sameConversation = await until(
      () => {
        const spawns = log().filter(
          (e) => e.kind === 'spawn' && e.sid === first[0].providerSessionId
        )
        return spawns.length >= 2 ? spawns : null
      },
      { tries: 40, gapMs: 250 }
    )
    t.check(
      "the discussion opened the run's conversation again",
      !!sameConversation,
      log()
        .filter((e) => e.kind === 'spawn')
        .map((e) => ({ sid: e.sid, resume: e.resume }))
    )
    await win.keyboard.press('Escape')

    // ── 2. An occurrence another server claimed is not run here ──
    t.equal(
      'the routine another server claimed has no run',
      (await runsOf(fixture, 'Claimed elsewhere')).length,
      0
    )
    t.equal(
      'its button says it never ran',
      await win
        .locator('[data-testid="routine-button"][data-routine="Claimed elsewhere"]')
        .getAttribute('data-state'),
      'never'
    )

    // ── 5. A team routine is listed as unable to run ──
    const team = (await listRoutines(fixture)).routines.find((v) => v.routine.name === 'Team job')
    t.equal(
      'team scope is refused with the reason',
      team?.routine.invalid,
      'team scope is not built yet'
    )
    t.equal(
      'its button reads invalid',
      await win
        .locator('[data-testid="routine-button"][data-routine="Team job"]')
        .getAttribute('data-state'),
      'invalid'
    )

    // ── 3. A run that ends without a report is failed ──
    await win.locator('[data-testid="routine-button"][data-routine="Silent"]').click()
    const silentPanel = win.locator('[data-testid="routine-panel"][data-routine="Silent"]')
    await silentPanel.waitFor({ timeout: 5000 })
    await silentPanel.locator('[data-testid="routine-run-again"]').click()
    const silent = await until(
      async () => {
        const runs = await runsOf(fixture, 'Silent')
        return runs.length && ended(runs[0]) ? runs[0] : null
      },
      { tries: 120, gapMs: 500 }
    )
    t.equal('a run with no report is failed', silent?.state, 'failed')
    t.check('with the reason', /without a report/.test(silent?.reason ?? ''), silent?.reason)
    t.equal('a manual run is marked so', silent?.trigger, 'manual')
    await win.keyboard.press('Escape')

    // ── Open as a tab: an ordinary tab on the run's conversation, in this window ──
    await button.click()
    await panel.waitFor({ timeout: 5000 })
    const rowsBefore = await win.locator('.sidebar-item').count()
    await panel.locator('[data-testid="routine-more"]').click()
    await panel.locator('[data-testid="routine-open-tab"]').click()
    const rowAdded = await until(
      async () => ((await win.locator('.sidebar-item').count()) > rowsBefore ? true : null),
      { tries: 40, gapMs: 250 }
    )
    t.check('Open as a tab adds a sidebar row', !!rowAdded, { rowsBefore })
    const thirdSpawn = await until(
      () => {
        const spawns = log().filter(
          (e) => e.kind === 'spawn' && e.sid === first[0].providerSessionId
        )
        return spawns.length >= 3 ? spawns.length : null
      },
      { tries: 60, gapMs: 250 }
    )
    t.check("the tab started the run's conversation", !!thirdSpawn, thirdSpawn)
    await win.keyboard.press('Escape')

    // ── 4. Invalid data is refused back with the errors; the corrected call lands ──
    await win.locator('[data-testid="routine-button"][data-routine="Retry"]').click()
    const retryPanel = win.locator('[data-testid="routine-panel"][data-routine="Retry"]')
    await retryPanel.waitFor({ timeout: 5000 })
    await retryPanel.locator('[data-testid="routine-run-again"]').click()
    const retry = await until(
      async () => {
        const runs = await runsOf(fixture, 'Retry')
        return runs.length && ended(runs[0]) ? runs[0] : null
      },
      { tries: 120, gapMs: 500 }
    )
    const refused = log().find((e) => e.kind === 'refused')
    const refusedText = JSON.stringify(refused?.result ?? '')
    t.check(
      'the invalid report was refused as an error',
      refused?.result?.isError === true || /error/i.test(refusedText),
      refused
    )
    t.check(
      'the refusal names what the schema refused',
      /does not match|must be array|additional properties/.test(refusedText),
      refusedText.slice(0, 300)
    )
    t.equal('the corrected report landed and the run is ok', retry?.state, 'ok')
    await win.keyboard.press('Escape')
  } finally {
    await app.close()
  }

  // ── 7a. A relaunch inside the same occurrence runs nothing twice ──
  // The quit left the clock ten hours back again; the latest occurrence is
  // the one the first life already claimed, so the claim holds and the first
  // tick skips it: a quit and a relaunch within the hour never double a run.
  seedClock(['Workspace health'], 10 * HOUR)
  ;({ app, win, fixture } = await launchApp(DIR, { env }))
  try {
    await until(async () => (await listRoutines(fixture)).routines.length > 0, { tries: 120 })
    await fixture.evaluate(async () => globalThis.__claveE2E.routines.tick())
    await sleep(1000)
    const same = await runsOf(fixture, 'Workspace health')
    t.equal('a relaunch inside the claimed occurrence adds no run', same.length, 1)
  } finally {
    await app.close()
  }

  // ── 7b. A relaunch once a new occurrence is due catches up exactly once ──
  // The hour passing is stood in for by the previous claims going (an
  // occurrence of the next hour has no claim yet); the clock is ten hours back.
  rmSync(path.join(DATA, 'routine-claims', hashKey(key('Workspace health'))), {
    recursive: true,
    force: true
  })
  seedClock(['Workspace health'], 10 * HOUR)
  ;({ app, win, fixture } = await launchApp(DIR, { env }))
  try {
    const after = await until(
      async () => {
        const runs = await runsOf(fixture, 'Workspace health')
        return runs.length >= 2 && ended(runs[0]) ? runs : null
      },
      { tries: 240, gapMs: 500 }
    )
    t.check('after the relaunch the routine ran once more', !!after, after)
    t.equal('exactly one catch-up run was added', after?.length, 2)
    t.equal('the new run is a catch-up', after?.[0]?.trigger, 'catch-up')
    t.check(
      'the history is kept across the relaunch',
      after?.[1]?.id === first?.[0]?.id,
      after?.map((r) => r.id)
    )
    // A second tick without a new occurrence adds nothing.
    await fixture.evaluate(async () => globalThis.__claveE2E.routines.tick())
    await sleep(500)
    t.equal(
      'a tick with nothing due runs nothing',
      (await runsOf(fixture, 'Workspace health')).length,
      2
    )
  } finally {
    await app.close()
  }
}
