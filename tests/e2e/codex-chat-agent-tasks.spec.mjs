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

/* A Codex chat's running work in the Terminal view, from real Codex
   captures (src/main/sessions/fixtures/codex-app-server/): agent-tasks.ndjson,
   one subagent that outlives the turn, one command left running and one the
   turn waits on; then agent-tasks-followup.ndjson, a finished subagent given
   more work. The stub pauses the replay at gates so the spec can look
   mid-turn. What this spec holds in the real app:
   - mid-turn, only the subagent shows: Codex does not say yet which command
     is left running, and a command shows only as background work;
   - when the turn ends, the subagent and the command left running stay,
     the command as background work; the waited-on command is gone;
   - the agent's row names the model Codex resolved and offers no relaunch;
     the command's row names no model at all;
   - the child thread's own words never reach the transcript;
   - a subscriber that binds late is handed the same two tasks, and the
     pane showing them does not double them;
   - each row goes at its own completion, after the turn;
   - a finished subagent given more work shows again for that run, by its
     first name and model, outlives the parent's turn, and goes at its end. */

const DIR = userDataDir('codex-chat-agent-tasks')
const ROOT = fixturePath('codex-chat-agent-tasks-root')
const BIN = `${ROOT}/bin`
const WORK = `${ROOT}/work`
const GATES = `${ROOT}/gates`
const gate = (name) => writeFileSync(`${GATES}/${name}`, '')
const FIXTURES = path.join(REPO, 'src/main/sessions/fixtures/codex-app-server')

function writeFixtures() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  mkdirSync(WORK, { recursive: true })
  mkdirSync(GATES, { recursive: true })
  seedWorkspaces(DIR, {
    workspaces: [{ id: 'tasks', name: 'Tasks', rootDir: WORK, profileFile: null, createdAt: 1 }],
    activeWorkspaceId: 'tasks',
    fresh: true
  })
  seedTrustedRoots(DIR, [ROOT])
  // The stub app-server answers the session's own requests and replays a
  // capture per turn, segment by segment: each segment ends at the first
  // frame its stop names, and the next one waits for the gate file of that
  // name. Turn 2's ids are renamed so its subagent is not turn 1's.
  writeFileSync(
    `${BIN}/codex`,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const load = (file, renames) => {
  let text = fs.readFileSync(path.join(${JSON.stringify(FIXTURES)}, file), 'utf8');
  for (const [from, to] of renames) text = text.split(from).join(to);
  return text.trim().split('\\n').map(JSON.parse);
};
const notes = (rows) => rows.filter((r) => r.direction === 'server' && r.frame.method && r.frame.id === undefined).map((r) => r.frame);
const first = load('agent-tasks.ndjson', []);
const start = first.find((r) => r.direction === 'server' && r.frame.id === 2).frame.result;
const parentEnd = (f) => f.method === 'turn/completed' && f.params.threadId === 'thread-parent';
const activity = (kind) => (f) => f.method === 'item/completed' && f.params.item.type === 'subAgentActivity' && f.params.item.kind === kind;
const turns = [
  { id: 'turn-parent', frames: notes(first), stops: [
    ['mid', (f) => f.method === 'item/started' && f.params.item.id === 'exec-dd741450-709a-478b-88e3-418eca00c348'],
    ['finish', parentEnd]
  ] },
  { id: 'turn-followup', frames: notes(load('agent-tasks-followup.ndjson', [['thread-child', 'thread-echoer'], ['turn-parent', 'turn-followup']])), stops: [
    ['first-run', activity('started')],
    ['rerun', activity('completed')],
    ['rerun-seen', (f) => f.method === 'turn/started' && f.params.threadId === 'thread-echoer' && f.params.turn.id !== 'turn-child-1'],
    ['parent-done', parentEnd]
  ] }
];
const send = (f) => process.stdout.write(JSON.stringify(f) + '\\n');
function play(frames, stops) {
  const [stop, ...rest] = stops;
  const next = () => {
    if (!frames.length) return;
    const f = frames.shift(); send(f);
    if (stop && stop[1](f)) {
      const wait = setInterval(() => { if (fs.existsSync(path.join(${JSON.stringify(GATES)}, stop[0]))) { clearInterval(wait); play(frames, rest) } }, 50);
      return;
    }
    setTimeout(next, 5);
  };
  next();
}
let turn = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const f = JSON.parse(line);
  if (!f.method || f.method === 'initialized') return;
  if (f.method === 'initialize') return send({ id: f.id, result: { userAgent: 'codex-stub/0.162.1' } });
  if (f.method === 'thread/start') { send({ id: f.id, result: start }); return send(notes(first).find((n) => n.method === 'thread/started')) }
  if (f.method === 'turn/start') {
    const t = turns[turn++];
    send({ id: f.id, result: { turn: { id: t.id, status: 'inProgress' } } });
    return play([...t.frames], t.stops);
  }
  send({ id: f.id, result: { data: [] } });
});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 }
  )
  writeFileSync(
    `${BIN}/sh`,
    `#!/bin/sh\nexport PATH='${BIN}':"$PATH"\n[ "$1" = '-l' ] && shift\nexec /bin/sh "$@"\n`,
    { mode: 0o755 }
  )
}

/** Every row of the stack as the reader sees it. */
const readRows = (view) =>
  view.locator('.term-agent:not([data-leaving])').evaluateAll((items) =>
    items.map((el) => {
      const icon = el.querySelector('svg.term-agent-icon')
      return {
        kind: el.getAttribute('data-kind'),
        background: el.hasAttribute('data-background'),
        type: el.querySelector('.term-agent-type')?.textContent ?? null,
        description: el.querySelector('.term-agent-description')?.textContent ?? null,
        model: el.querySelector('.term-agent-model')?.textContent ?? null,
        relaunch: !!el.querySelector('button.term-agent-model'),
        dot: !!el.querySelector('.term-agent-dot'),
        icon: icon
          ? {
              width: Math.round(icon.getBoundingClientRect().width),
              animation: getComputedStyle(icon).animationName
            }
          : null
      }
    })
  )

export async function run(t) {
  writeFixtures()
  const env = { SHELL: `${BIN}/sh`, PATH: `${BIN}:${process.env.PATH}` }
  let app = null
  try {
    const launched = await launchApp(DIR, { server: 'in-process', env })
    app = launched.app
    const win = launched.win
    const fixture = launched.fixture
    const opened = await callMcp(app, 'openSession', {
      cwd: WORK,
      mode: 'codex',
      chat: true,
      workspace: 'tasks'
    })
    const id = opened?.sessionId
    if (!id) throw new Error(`openSession produced no Codex chat tab: ${JSON.stringify(opened)}`)
    await win.evaluate(
      (id) => window.electronAPI.sessionsSetView(id, 'clave.chat-view/terminal'),
      id
    )
    const viewOf = (page) =>
      page.locator(`section.chat-host[data-session-id="${id}"] [data-testid="terminal-view"]`)
    let view = viewOf(win)
    await view.locator('textarea:not(:disabled)').waitFor({ timeout: 15_000 })
    await view.locator('textarea').fill('Run the agent tasks')
    await view.locator('textarea').press('Enter')
    const state = async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).find((s) => s.id === id)?.state
    // SessionHost.subscribe is what every new binding goes through, from a
    // window's IPC or the server's push channel; the window's own preload
    // shares one subscription per session, so it is asked here directly.
    // What it hands over is the provider's background list, the one the
    // tab's background count reads.
    const heldList = () =>
      fixture.evaluate(async (id) => {
        const seen = []
        const off = globalThis.__claveE2E.sessionHost.subscribe(id, (value) => {
          if (value.kind === 'event' && value.event.type === 'background_tasks')
            seen.push(value.event.tasks)
        })
        await new Promise((resolve) => setTimeout(resolve, 300))
        off()
        return seen
      }, id)

    /* 1. Mid-turn: both commands have started (the transcript's group counts
       two), and only the subagent shows. */
    const mid = await until(
      async () => {
        const text = await view.innerText()
        const rows = await readRows(view)
        return /\b2 commands\b/.test(text) && rows.length ? rows : null
      },
      { tries: 60 }
    )
    const midState = await state()
    const midHeld = (await heldList())[0] ?? []
    t.check(
      'mid-turn, the subagent alone shows: neither running command has a row before it is background work',
      midState === 'working' &&
        mid?.map((row) => `${row.kind}:${row.description}`).join('|') === 'agent:sleep_test' &&
        midHeld.map((task) => task.id).join(',') === 'thread-child',
      { midState, mid, midHeld }
    )
    gate('mid')

    /* 2. The turn ends with the subagent and the command still running. */
    const listed = await until(
      async () => {
        const rows = await readRows(view)
        return rows.length === 2 && (await state()) === 'done' ? rows : null
      },
      { tries: 60 }
    )
    const [agent, shell] = listed ?? []
    t.check(
      'at the turn end both rows stay: the subagent first, then the command',
      agent?.kind === 'agent' && shell?.kind === 'shell',
      { listed, state: await state() }
    )
    t.check(
      "the agent's row names what it was spawned as and the model Codex resolved, with no relaunch",
      agent?.description === 'sleep_test' &&
        agent?.type === 'agent' &&
        agent?.model === 'gpt-6.1-sol' &&
        agent?.relaunch === false &&
        agent?.dot === true,
      agent
    )
    t.check(
      'the command left running is background work now, behind the glyph breathing like the dot, with no model or type',
      shell?.description === 'sleep 30 && echo bg2' &&
        shell?.background === true &&
        shell?.icon?.width === 12 &&
        shell?.icon?.animation === 'pulse-dot' &&
        shell?.dot === false &&
        shell?.model === null &&
        shell?.type === null,
      shell
    )
    const transcript = await view.innerText()
    t.check(
      "the waited-on command left with its result, and the child's words are not in the transcript",
      !listed?.some((row) => row.description?.includes('echo fg')) &&
        !/20-second wait|\bDone\./.test(transcript) &&
        transcript.includes('ok'),
      { rows: listed?.map((r) => r.description) }
    )

    /* 3. A subscriber that binds now (a pane remounting, another window)
       is handed the held list, and the pane already showing it does not
       double its rows. */
    const handed = await heldList()
    const first = handed[0] ?? []
    const settled = await readRows(view)
    t.check(
      'a late subscriber is handed both tasks, the model kept; the pane still shows them once each',
      first.length === 2 &&
        first[0].id === 'thread-child' &&
        first[0].model === 'gpt-6.1-sol' &&
        first[1].kind === 'shell' &&
        settled.length === 2 &&
        settled.map((row) => row.description).join('|') === 'sleep_test|sleep 30 && echo bg2',
      { handed, settled }
    )

    /* 4. The work finishes after the turn: each row goes at its own end. */
    gate('finish')
    const gone = await until(
      async () => {
        const rows = await view.locator('.term-agent').count()
        return rows === 0 ? true : null
      },
      { tries: 60 }
    )
    t.check('the command and the agent leave the stack at their own completion', !!gone, {
      left: await readRows(view)
    })

    /* 5. A subagent spawned, finished, then given more work. */
    await until(async () => (await view.locator('textarea:not(:disabled)').count()) === 1)
    await view.locator('textarea').fill('Give the agent more work')
    await view.locator('textarea').press('Enter')
    const rowsNow = async () =>
      (await readRows(view)).map((row) => `${row.kind}:${row.description}:${row.model}`).join('|')
    const firstRun = await until(
      async () => ((await rowsNow()) === 'agent:echoer:gpt-6.1-sol' ? true : null),
      { tries: 60 }
    )
    gate('first-run')
    const firstRunEnded = await until(async () => ((await rowsNow()) === '' ? true : null), {
      tries: 60
    })
    gate('rerun')
    const rerun = await until(
      async () => ((await rowsNow()) === 'agent:echoer:gpt-6.1-sol' ? await rowsNow() : null),
      { tries: 60 }
    )
    t.check(
      'a finished subagent shows again for its next run, by its first name and model',
      !!firstRun && !!firstRunEnded && rerun === 'agent:echoer:gpt-6.1-sol',
      { firstRun, firstRunEnded, rows: await rowsNow() }
    )
    gate('rerun-seen')
    const parentDone = await until(async () => ((await state()) === 'done' ? true : null), {
      tries: 60
    })
    const afterParent = await rowsNow()
    t.check(
      "its run outlives the parent's turn",
      !!parentDone && afterParent === 'agent:echoer:gpt-6.1-sol',
      { afterParent, state: await state() }
    )
    gate('parent-done')
    const rerunGone = await until(
      async () => ((await view.locator('.term-agent').count()) === 0 ? true : null),
      { tries: 60 }
    )
    t.check('and it leaves the stack at that run end', !!rerunGone, { rows: await rowsNow() })
  } finally {
    if (app) await app.close()
    rmSync(ROOT, { recursive: true, force: true })
    rmSync(DIR, { recursive: true, force: true })
  }
}
