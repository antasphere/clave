import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

/* A Codex chat's running work in the Terminal view, from a real Codex
   capture (src/main/sessions/fixtures/codex-app-server/agent-tasks.ndjson):
   one subagent that outlives the turn, one background command, and one
   foreground command. What this spec holds in the real app:
   - when the turn ends, the subagent and the command are listed, the command
     behind the terminal glyph; the foreground command is not;
   - the agent's row names the model Codex resolved and offers no relaunch;
     the command's row names no model at all;
   - the child thread's own words never reach the transcript;
   - a subscriber that binds late is handed the same two tasks, and the
     pane showing them does not double them;
   - each row goes at its own completion, after the turn. */

const DIR = userDataDir('codex-chat-agent-tasks')
const ROOT = fixturePath('codex-chat-agent-tasks-root')
const BIN = `${ROOT}/bin`
const WORK = `${ROOT}/work`
const FINISH = `${ROOT}/finish`
const FIXTURE = path.join(REPO, 'src/main/sessions/fixtures/codex-app-server/agent-tasks.ndjson')

function writeFixtures() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  mkdirSync(WORK, { recursive: true })
  seedWorkspaces(DIR, {
    workspaces: [{ id: 'tasks', name: 'Tasks', rootDir: WORK, profileFile: null, createdAt: 1 }],
    activeWorkspaceId: 'tasks',
    fresh: true
  })
  seedTrustedRoots(DIR, [ROOT])
  // The stub app-server answers the session's own requests and replays the
  // capture: the turn up to its end at once, the rest once FINISH exists.
  writeFileSync(
    `${BIN}/codex`,
    `#!${process.execPath}
const fs = require('node:fs');
const rows = fs.readFileSync(${JSON.stringify(FIXTURE)}, 'utf8').trim().split('\\n').map(JSON.parse);
const send = (f) => process.stdout.write(JSON.stringify(f) + '\\n');
const start = rows.find((r) => r.direction === 'server' && r.frame.id === 2).frame.result;
const notes = rows.filter((r) => r.direction === 'server' && r.frame.method && r.frame.id === undefined).map((r) => r.frame);
const end = notes.findIndex((f) => f.method === 'turn/completed' && f.params.threadId === 'thread-parent');
const play = (frames, then) => { const next = () => { if (!frames.length) return then && then(); send(frames.shift()); setTimeout(next, 5) }; next() };
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const f = JSON.parse(line);
  if (!f.method) return;
  if (f.method === 'initialized') return;
  if (f.method === 'initialize') return send({ id: f.id, result: { userAgent: 'codex-stub/0.162.1' } });
  if (f.method === 'thread/start') { send({ id: f.id, result: start }); return send(notes.find((n) => n.method === 'thread/started')) }
  if (f.method === 'turn/start') {
    send({ id: f.id, result: { turn: { id: 'turn-parent', status: 'inProgress' } } });
    return play(notes.slice(0, end + 1), () => {
      const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(FINISH)})) { clearInterval(wait); play(notes.slice(end + 1)) } }, 100);
    });
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

    /* 1. The turn ends with the subagent and the command still running. */
    const state = async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).find((s) => s.id === id)?.state
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
      "the command's row has the terminal glyph, breathing like the dot, and no model or type",
      shell?.description === 'sleep 30 && echo bg2' &&
        shell?.icon?.width === 12 &&
        shell?.icon?.animation === 'pulse-dot' &&
        shell?.dot === false &&
        shell?.model === null &&
        shell?.type === null,
      shell
    )
    const transcript = await view.innerText()
    t.check(
      "the foreground command is no row, and the child's words are not in the transcript",
      !listed?.some((row) => row.description?.includes('echo fg')) &&
        !/20-second wait|\bDone\./.test(transcript) &&
        transcript.includes('ok'),
      { rows: listed?.map((r) => r.description) }
    )

    /* 2. A subscriber that binds now (a pane remounting, another window)
       is handed the held list, and the pane already showing it does not
       double its rows. */
    // SessionHost.subscribe is what every new binding goes through, from a
    // window's IPC or the server's push channel; the window's own preload
    // shares one subscription per session, so it is asked here directly.
    const handed = await fixture.evaluate(async (id) => {
      const seen = []
      const off = globalThis.__claveE2E.sessionHost.subscribe(id, (value) => {
        if (value.kind === 'event' && value.event.type === 'background_tasks')
          seen.push(value.event.tasks)
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      off()
      return seen
    }, id)
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

    /* 3. The work finishes after the turn: each row goes at its own end. */
    writeFileSync(FINISH, '')
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
  } finally {
    if (app) await app.close()
    if (!existsSync(FINISH)) writeFileSync(FINISH, '')
    rmSync(ROOT, { recursive: true, force: true })
    rmSync(DIR, { recursive: true, force: true })
  }
}
