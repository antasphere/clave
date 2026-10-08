// Pinned to the in-process server (wave 3 of the server/client split,
// PRDCT-3293): this spec restarts the app and expects its sessions back. On
// an attached server the records are the server's, but the window's restore
// still reads main's own list (`pty:list`) and main's folder, so nothing is
// brought back: the restore of persisted sessions on the standalone server
// is wave 3's named leftover (ADR 0003). Not a known failure.
/**
 * A Codex chat tab survives an app restart, in whichever workspace it lives.
 *
 * The bug: only a Claude chat tab wrote a session record, and the record is
 * all that survives a quit. A Codex chat tab (launch profile `codex-chat`,
 * events transport, no PTY) wrote none, so it vanished at the next launch —
 * and a workspace worked in Codex lost every tab at every restart while the
 * workspace worked in Claude came back whole.
 *
 * The check is the RESTART on one user-data dir, shaped like the report: two
 * workspaces, the Codex tabs in the one NOT shown. One tab talks once (the
 * stub writes the rollout a real app-server would), one never does. Quit,
 * relaunch, accept the restore prompt, and require both tabs back under
 * their own ids, in their own workspace, as Codex chats: the one that talked
 * resuming its thread, the silent one starting a fresh thread (Codex cannot
 * resume a thread with no rollout).
 *
 * Nothing here reaches OpenAI: `codex` on PATH is a stub speaking the
 * app-server protocol, and CLAVE_CODEX_ROOT points the rollout lookup at a
 * fixture dir, never at ~/.codex.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('codex-chat-tab-restore')
const ROOT = fixturePath('codex-chat-restore-root')
const BIN = `${ROOT}/bin`
const ROLLOUTS = `${ROOT}/codex-sessions`
const RPC_LOG = `${ROOT}/rpc.jsonl`
const SHOWN = { id: 'codex-restore-shown', name: 'Shown', rootDir: `${ROOT}/shown` }
const HIDDEN = { id: 'codex-restore-hidden', name: 'Hidden', rootDir: `${ROOT}/hidden` }
const recordPath = (id) => path.join(DIR, 'session-records', `${id}.json`)
const readRecord = (id) => {
  try {
    return JSON.parse(readFileSync(recordPath(id), 'utf8'))
  } catch {
    return null
  }
}
/** Every request the stub app-servers received, oldest first. */
const requests = () => {
  try {
    return readFileSync(RPC_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  } catch {
    return []
  }
}

function writeFixtures() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  mkdirSync(SHOWN.rootDir, { recursive: true })
  mkdirSync(HIDDEN.rootDir, { recursive: true })
  mkdirSync(ROLLOUTS, { recursive: true })
  seedWorkspaces(DIR, {
    workspaces: [SHOWN, HIDDEN].map((w) => ({ ...w, profileFile: null, createdAt: 1 })),
    activeWorkspaceId: SHOWN.id,
    fresh: true
  })
  seedTrustedRoots(DIR, [ROOT])
  // The stub app-server: every thread/start mints a thread, thread/resume
  // answers for the thread it names, and a turn writes the thread's rollout
  // where Codex keeps it — the file a restore looks for before resuming.
  writeFileSync(
    `${BIN}/codex`,
    `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const send = (f) => process.stdout.write(JSON.stringify(f) + '\\n');
let thread = null;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const f = JSON.parse(line);
  if (!f.method) return;
  fs.appendFileSync(${JSON.stringify(RPC_LOG)}, JSON.stringify({ pid: process.pid, method: f.method, params: f.params }) + '\\n');
  if (f.method === 'initialize') return send({ id: f.id, result: { userAgent: 'codex-stub/0.157.0' } });
  if (f.method === 'initialized') return;
  if (f.method === 'thread/start' || f.method === 'thread/resume') {
    thread = f.method === 'thread/resume' ? f.params.threadId : require('node:crypto').randomUUID();
    return send({ id: f.id, result: { thread: { id: thread }, model: 'gpt-stub' } });
  }
  if (f.method === 'turn/start') {
    fs.writeFileSync(path.join(${JSON.stringify(ROLLOUTS)}, 'rollout-2026-09-28T10-00-00-' + thread + '.jsonl'), '{}\\n');
    return send({ id: f.id, result: { turn: { id: 'turn-' + Date.now(), status: 'completed' } } });
  }
  send({ id: f.id, result: {} });
});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 }
  )
  // The login-shell launch, with the fixture PATH kept first.
  writeFileSync(
    `${BIN}/sh`,
    `#!/bin/sh\nexport PATH='${BIN}':"$PATH"\n[ "$1" = '-l' ] && shift\nexec /bin/sh "$@"\n`,
    { mode: 0o755 }
  )
}

export async function run(t) {
  writeFixtures()
  const env = { SHELL: `${BIN}/sh`, PATH: `${BIN}:${process.env.PATH}`, CLAVE_CODEX_ROOT: ROLLOUTS }
  let app = null
  const kernel = async (win, id) =>
    (await win.evaluate(() => window.electronAPI.sessionsList())).find((s) => s.id === id)
  const say = (win, id, text) =>
    win.evaluate(
      async ({ id, text }) => {
        await window.electronAPI.sessionsSubscribe(id)
        await window.electronAPI.sessionsWrite(id, { type: 'user_message', text })
      },
      { id, text }
    )
  try {
    // ── Launch 1: two Codex chat tabs in the workspace NOT shown ──
    let launched = await launchApp(DIR, { server: 'in-process', env })
    app = launched.app
    let win = launched.win
    const open = async () =>
      (
        await callMcp(app, 'openSession', {
          cwd: HIDDEN.rootDir,
          mode: 'codex',
          chat: true,
          workspace: HIDDEN.id
        })
      )?.sessionId
    const talked = await open()
    const silent = await open()
    t.check('launch 1: two Codex chat tabs opened in the hidden workspace', !!talked && !!silent, {
      talked,
      silent
    })
    if (!talked || !silent) throw new Error('openSession produced no Codex chat tab')
    t.check(
      'launch 1: both are codex-chat events sessions',
      (await kernel(win, talked))?.adapterId === 'codex-chat' &&
        (await kernel(win, silent))?.adapterId === 'codex-chat'
    )

    await say(win, talked, 'first message')
    const started = await until(() => requests().find((r) => r.method === 'turn/start'))
    const thread = requests().find((r) => r.method === 'thread/start')?.params && started
    t.check('launch 1: the tab that talked ran a turn', !!thread)

    const talkedRecord = await until(() => readRecord(talked)?.codexThreadId && readRecord(talked))
    const threadId = talkedRecord?.codexThreadId
    t.check(
      "launch 1: the talking tab's record is a Codex chat's, in the hidden workspace, with its thread",
      talkedRecord?.adapterId === 'codex-chat' &&
        talkedRecord?.transport === 'events' &&
        talkedRecord?.codexMode === true &&
        talkedRecord?.workspaceId === HIDDEN.id &&
        typeof threadId === 'string',
      talkedRecord
    )
    t.check(
      'launch 1: the thread has a rollout on disk',
      !!threadId && existsSync(path.join(ROLLOUTS, `rollout-2026-09-28T10-00-00-${threadId}.jsonl`))
    )
    // The chat view brings the app-server up before any message (it lists
    // the models), so the silent tab's thread is opened too: its record names
    // a thread Codex never wrote a rollout for — the one a resume would fail.
    const silentRecord = readRecord(silent)
    t.check(
      'launch 1: the silent tab has a record too, its thread without a rollout',
      silentRecord?.adapterId === 'codex-chat' &&
        silentRecord?.workspaceId === HIDDEN.id &&
        !existsSync(
          path.join(ROLLOUTS, `rollout-2026-09-28T10-00-00-${silentRecord?.codexThreadId}.jsonl`)
        ),
      silentRecord
    )

    // ── Quit keeps both records ──
    await app.close()
    app = null
    t.check(
      'quit: both Codex chat records survive app.close()',
      existsSync(recordPath(talked)) && existsSync(recordPath(silent))
    )

    // ── Launch 2: accept the restore prompt ──
    launched = await launchApp(DIR, { server: 'in-process', env, settleMs: 3000 })
    app = launched.app
    win = launched.win
    const restore = win.getByRole('button', { name: 'Restore', exact: true })
    const prompted = await until(() => restore.isVisible().catch(() => false))
    t.check('launch 2: the restore prompt is offered', !!prompted)
    if (!prompted) throw new Error('no restore prompt at launch 2')
    await restore.click()

    const listed = async () =>
      (await callMcp(app, 'list', { workspace: 'all' })).sessions.filter((s) =>
        [talked, silent].includes(s.id)
      )
    const back = await until(async () => ((await listed()).length === 2 ? await listed() : null))
    t.check('launch 2: both tabs are back under their own ids', !!back, await listed())
    t.check(
      'launch 2: both are back in the hidden workspace, not the shown one',
      !!back && back.every((s) => s.workspaceId === HIDDEN.id),
      back
    )
    t.check(
      'launch 2: both are codex-chat events sessions again, not terminals',
      (await kernel(win, talked))?.adapterId === 'codex-chat' &&
        (await kernel(win, silent))?.transport === 'events'
    )

    // The app-server comes up on first input: send one to each and read
    // which thread method it got.
    const before = requests().length
    await say(win, talked, 'after restore')
    await say(win, silent, 'after restore')
    const after = await until(() => {
      const fresh = requests().slice(before)
      return fresh.filter((r) => r.method === 'turn/start').length === 2 ? fresh : null
    })
    const resumes = (after ?? []).filter((r) => r.method === 'thread/resume')
    const starts = (after ?? []).filter((r) => r.method === 'thread/start')
    t.check(
      'launch 2: the tab that talked resumed its own thread',
      resumes.length === 1 && resumes[0].params.threadId === threadId,
      after
    )
    t.check(
      'launch 2: the silent tab started a fresh thread instead of failing a resume',
      starts.length === 1,
      after
    )

    // ── A real close forgets the tab ──
    await callMcp(app, 'closeSession', { sessionId: talked })
    const gone = await until(() => !existsSync(recordPath(talked)))
    t.check('close: the Codex chat record is discarded on a real close', !!gone)
  } finally {
    if (app) await app.close()
    // Only the stub processes this spec recorded are ours to kill, by PID.
    for (const pid of new Set(requests().map((r) => r.pid))) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') console.error('Stub cleanup failed', error)
      }
    }
    rmSync(DIR, { recursive: true, force: true })
    rmSync(ROOT, { recursive: true, force: true })
  }
}
