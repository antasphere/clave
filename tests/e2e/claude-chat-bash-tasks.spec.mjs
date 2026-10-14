import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  REPO,
  callMcp,
  fixturePath,
  launchApp,
  seedTrustedRoots,
  seedWorkspaces,
  until,
  userDataDir
} from './harness.mjs'

/* A Claude chat's Bash commands in the Terminal view, from a real Claude
   Code capture (src/main/sessions/fixtures/claude-stream/background-bash.ndjson)
   replayed through the real Claude adapter: one Bash call run in the
   background, one waited on. The stub pauses the replay at gates so the spec
   can look between frames. What this spec holds in the real app:
   - a Bash call shows its terminal card from its tool_use, before any
     background notification, as running work;
   - the waited-on call shows beside it;
   - the background list naming the call promotes the same card: still one
     card for it, now background work;
   - the waited-on card leaves with its result, the background one stays past
     the turn, with no model and no relaunch, and leaves at its completion. */

const DIR = userDataDir('claude-chat-bash-tasks')
const ROOT = fixturePath('claude-chat-bash-tasks-root')
const BIN = `${ROOT}/bin`
const WORK = `${ROOT}/work`
const GATES = `${ROOT}/gates`
const gate = (name) => writeFileSync(`${GATES}/${name}`, '')
const FIXTURE = path.join(REPO, 'src/main/sessions/fixtures/claude-stream/background-bash.ndjson')

function writeFixtures() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  mkdirSync(WORK, { recursive: true })
  mkdirSync(GATES, { recursive: true })
  seedWorkspaces(DIR, {
    workspaces: [{ id: 'bash', name: 'Bash', rootDir: WORK, profileFile: null, createdAt: 1 }],
    activeWorkspaceId: 'bash',
    fresh: true
  })
  seedTrustedRoots(DIR, [ROOT])
  // A login shell that keeps the stub-first PATH.
  writeFileSync(
    `${BIN}/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  // The stub CLI: the title one-shot answers a title; the chat process
  // replays the capture on the reader's message, segment by segment, each
  // segment ending at the first frame its stop names and the next waiting for
  // the gate file of that name.
  writeFileSync(
    `${BIN}/claude`,
    `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const readline = require('node:readline');
if (!process.argv.includes('--session-id')) { process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('bash tasks\\n'); process.exit(0); }); return; }
const argv = process.argv.slice(2); const providerId = argv[argv.indexOf('--session-id') + 1];
const frames = fs.readFileSync(${JSON.stringify(FIXTURE)}, 'utf8').trim().split('\\n').map(JSON.parse);
for (const frame of frames) if (frame.session_id) frame.session_id = providerId;
const uses = (f, pick) => f.type === 'assistant' && (f.message.content || []).some((b) => b.type === 'tool_use' && pick(b.input));
const stops = [
  ['background-call', (f) => uses(f, (input) => input.run_in_background === true)],
  ['waited-call', (f) => uses(f, (input) => input.command === 'echo fgc')],
  ['listed', (f) => f.type === 'system' && f.subtype === 'task_started'],
  ['turn-end', (f) => f.type === 'result']
];
const emit = (f) => process.stdout.write(JSON.stringify(f) + '\\n');
function play(rest, gates) {
  const [stop, ...later] = gates;
  const next = () => {
    if (!rest.length) return;
    const f = rest.shift(); emit(f);
    if (stop && stop[1](f)) {
      const wait = setInterval(() => { if (fs.existsSync(path.join(${JSON.stringify(GATES)}, stop[0]))) { clearInterval(wait); play(rest, later) } }, 50);
      return;
    }
    setTimeout(next, 5);
  };
  next();
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  if (input.type === 'user') play([...frames], stops);
  if (input.type === 'control_request' && input.request.subtype === 'initialize')
    emit({ type: 'control_response', response: { subtype: 'success', request_id: input.request_id, response: { models: [{ value: 'haiku', displayName: 'Haiku' }] } } });
});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 }
  )
}

/** Every card of the stack as the reader sees it. */
const readRows = (view) =>
  view.locator('.term-agent:not([data-leaving])').evaluateAll((items) =>
    items.map((el) => ({
      kind: el.getAttribute('data-kind'),
      background: el.hasAttribute('data-background'),
      description: el.querySelector('.term-agent-description')?.textContent ?? null,
      icon: !!el.querySelector('svg.term-agent-icon'),
      model: el.querySelector('.term-agent-model')?.textContent ?? null,
      relaunch: !!el.querySelector('button.term-agent-model')
    }))
  )
const describe = (rows) =>
  rows.map((row) => `${row.kind}:${row.description}:${row.background ? 'bg' : 'run'}`).join('|')

export async function run(t) {
  writeFixtures()
  const env = { SHELL: `${BIN}/bash`, PATH: `${BIN}:${process.env.PATH}` }
  let app = null
  try {
    const launched = await launchApp(DIR, { server: 'in-process', env })
    app = launched.app
    const win = launched.win
    const opened = await callMcp(app, 'openSession', {
      cwd: WORK,
      mode: 'claude',
      chat: true,
      workspace: 'bash'
    })
    const id = opened?.sessionId
    if (!id) throw new Error(`openSession produced no Claude chat tab: ${JSON.stringify(opened)}`)
    await win.evaluate(
      (id) => window.electronAPI.sessionsSetView(id, 'clave.chat-view/terminal'),
      id
    )
    const view = win.locator(
      `section.chat-host[data-session-id="${id}"] [data-testid="terminal-view"]`
    )
    await view.locator('textarea:not(:disabled)').waitFor({ timeout: 15_000 })
    await view.locator('textarea').fill('Run the Bash tasks')
    await view.locator('textarea').press('Enter')
    const state = async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).find((s) => s.id === id)?.state
    const reach = (expected) =>
      until(
        async () => {
          const rows = await readRows(view)
          return describe(rows) === expected ? rows : null
        },
        { tries: 60 }
      )

    /* 1. The background call's tool_use alone: its card, as running work. */
    const first = await reach('shell:sleep 10 && echo bgc:run')
    t.check(
      'a Bash call shows its terminal card from its tool_use, before any background notification',
      !!first && first[0].icon && first[0].model === null && !first[0].relaunch,
      { rows: describe(await readRows(view)) }
    )
    gate('background-call')

    /* 2. The waited-on call joins it. */
    const both = await reach('shell:sleep 10 && echo bgc:run|shell:echo fgc:run')
    t.check('the waited-on Bash call shows beside it, both as running work', !!both, {
      rows: describe(await readRows(view))
    })
    gate('waited-call')

    /* 3. The background list names the call: the same card, promoted. */
    const promoted = await reach('shell:sleep 10 && echo bgc:bg|shell:echo fgc:run')
    t.check(
      'the background list promotes the same card, never adding a second one',
      !!promoted &&
        promoted.filter((row) => row.description === 'sleep 10 && echo bgc').length === 1,
      { rows: describe(await readRows(view)) }
    )
    gate('listed')

    /* 4. The turn ends: the waited-on card left with its result, the
       background one stays. */
    const ended = await until(
      async () => {
        const rows = await readRows(view)
        return describe(rows) === 'shell:sleep 10 && echo bgc:bg' && (await state()) === 'done'
          ? rows
          : null
      },
      { tries: 60 }
    )
    t.check(
      'past the turn, one background card stays, with no model and no relaunch',
      !!ended && ended[0].icon && ended[0].model === null && !ended[0].relaunch,
      { rows: describe(await readRows(view)), state: await state() }
    )
    gate('turn-end')

    /* 5. Its completion takes it. */
    const gone = await until(
      async () => ((await view.locator('.term-agent').count()) === 0 ? true : null),
      { tries: 60 }
    )
    t.check('the background card leaves at its completion', !!gone, {
      rows: describe(await readRows(view))
    })
  } finally {
    if (app) await app.close()
    rmSync(ROOT, { recursive: true, force: true })
    rmSync(DIR, { recursive: true, force: true })
  }
}
