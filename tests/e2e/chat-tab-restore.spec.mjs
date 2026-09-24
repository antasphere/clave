/**
 * A Claude chat tab survives an app restart, and a real close forgets it.
 *
 * The bug: a chat tab (launch profile `claude-chat`, events transport, no PTY)
 * wrote no session record, and the record is all that survives a quit. So
 * every chat tab vanished at the next launch, conversation and all.
 *
 * The check is the RESTART on one user-data dir: open a chat tab the way the
 * launcher does, talk to it once (a stub `claude` writes the transcript a real
 * CLI would), quit, relaunch, accept the restore prompt, and require the SAME
 * tab back, relaunched with `--resume <its conversation>`. Then close it for
 * real and require the record gone, so a closed tab never comes back.
 *
 * Nothing here reaches Anthropic: `claude` on PATH is a stub replaying the
 * recorded stream fixture, and CLAVE_TRANSCRIPTS_ROOT points the transcript
 * lookup at a fixture dir, never at ~/.claude.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  REPO,
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  until,
  userDataDir
} from './harness.mjs'

const DIR = userDataDir('chat-tab-restore')
const ROOT = '/tmp/clave-e2e-chat-restore-root'
const TRANSCRIPTS = `${ROOT}/transcripts`
const ARGV_LOG = `${ROOT}/argv.jsonl`
const FIRST_PROMPT = 'first launch prompt'
const SECOND_PROMPT = 'after restore prompt'
const recordPath = (id) => path.join(DIR, 'session-records', `${id}.json`)
const readRecord = (id) => {
  try {
    return JSON.parse(readFileSync(recordPath(id), 'utf8'))
  } catch {
    return null
  }
}
/** Every chat launch of the stub, oldest first. */
const launches = () => {
  try {
    return readFileSync(ARGV_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  } catch {
    return []
  }
}
const argAfter = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null)

function writeFixtures() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(`${ROOT}/bin`, { recursive: true })
  mkdirSync(TRANSCRIPTS, { recursive: true })
  seedWorkspaces(DIR, {
    workspaces: [
      {
        id: 'chat-restore-ws',
        name: 'Chat restore',
        rootDir: ROOT,
        profileFile: null,
        createdAt: 1
      }
    ],
    activeWorkspaceId: 'chat-restore-ws',
    fresh: true
  })
  seedTrustedRoots(DIR, [ROOT])
  // A login shell fixture preserves the stub-first PATH instead of the host's path_helper.
  writeFileSync(
    `${ROOT}/bin/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  // The stub CLI: logs its argv on every start, and on each user message
  // appends the turn to the transcript where Claude Code keeps it
  // (<root>/<cwd, dashed>/<session id>.jsonl) and replays a recorded turn.
  writeFileSync(
    `${ROOT}/bin/claude`,
    `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const readline = require('node:readline');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ARGV_LOG)}, JSON.stringify({ pid: process.pid, argv }) + '\\n');
const at = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null;
const sid = at('--resume') || at('--session-id');
const root = process.env.CLAVE_TRANSCRIPTS_ROOT;
const cwd = ${JSON.stringify(ROOT)};
const transcript = path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), sid + '.jsonl');
const frames = fs.readFileSync(${JSON.stringify(path.join(REPO, 'src/main/sessions/fixtures/claude-stream/real-turn.ndjson'))}, 'utf8').trim().split('\\n').map(JSON.parse);
for (const frame of frames) if (frame.session_id) frame.session_id = sid;
const emit = (f) => process.stdout.write(JSON.stringify(f) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  if (input.type !== 'user') return;
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const base = { sessionId: sid, cwd, timestamp: new Date().toISOString() };
  fs.appendFileSync(transcript,
    JSON.stringify({ ...base, type: 'user', uuid: require('node:crypto').randomUUID(), message: { role: 'user', content: input.message.content } }) + '\\n' +
    JSON.stringify({ ...base, type: 'assistant', uuid: require('node:crypto').randomUUID(), message: { role: 'assistant', content: [{ type: 'text', text: 'CLAVE_OK' }] } }) + '\\n');
  for (const frame of frames) emit(frame);
});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 }
  )
}

export async function run(t) {
  writeFixtures()
  const env = {
    SHELL: `${ROOT}/bin/bash`,
    PATH: `${ROOT}/bin:${process.env.PATH}`,
    CLAVE_TRANSCRIPTS_ROOT: TRANSCRIPTS
  }
  let app = null
  const pids = new Set()
  try {
    // ── Launch 1: a chat tab from the launcher, one message ──
    let launched = await launchApp(DIR, { env })
    app = launched.app
    let win = launched.win
    await win.evaluate(async (command) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'restore-profile',
        name: 'Restore profile',
        family: 'claude',
        command: [command],
        additionalArgs: ['--profile', 'restored account']
      })
      await window.electronAPI.launchProfileSetGlobal('claude', 'chat:claude:restore-profile')
    }, `${ROOT}/bin/claude`)
    await win.reload()
    await win.locator('.launcher-split .launcher-btn').waitFor()
    await win.click('.launcher-split .launcher-btn')
    const chat = await until(async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).find(
        (s) => s.adapterId === 'claude-chat'
      )
    )
    if (!chat) throw new Error('the launcher never produced a claude-chat session')
    const tabId = chat.id
    const inStore = await until(async () =>
      (await callMcp(app, 'list', {})).sessions.some((s) => s.id === tabId)
    )
    t.check('launch 1: the chat tab is in the renderer store', !!inStore, tabId)

    await win.evaluate(
      async ({ id, text }) => {
        window.__turn = []
        window.electronAPI.onSessionStream(id, (v) => window.__turn.push(v.event))
        await window.electronAPI.sessionsSubscribe(id)
        await window.electronAPI.sessionsWrite(id, { type: 'user_message', text })
      },
      { id: tabId, text: FIRST_PROMPT }
    )
    const turnDone = await until(async () =>
      (await win.evaluate(() => window.__turn)).some(
        (e) => e.type === 'assistant_text' && String(e.delta).includes('CLAVE_OK')
      )
    )
    t.check('launch 1: the stub answered the first message', !!turnDone)
    const first = launches().at(-1)
    if (first) pids.add(first.pid)
    const claudeSessionId = argAfter(first?.argv ?? [], '--session-id')
    t.check('launch 1: the CLI was started fresh with --session-id', !!claudeSessionId, first)
    const transcript = path.join(
      TRANSCRIPTS,
      ROOT.replace(/[^a-zA-Z0-9]/g, '-'),
      `${claudeSessionId}.jsonl`
    )
    t.check('launch 1: the stub wrote the transcript', existsSync(transcript), transcript)

    // Assertion 1: the chat tab has a record naming its conversation.
    const record = await until(() => readRecord(tabId), { tries: 20 })
    t.check(
      'launch 1: session-records/<tabId>.json exists for the chat tab',
      !!record,
      recordPath(tabId)
    )
    t.check(
      "launch 1: the record is the chat adapter's, carrying the tab's Claude session id",
      record?.adapterId === 'claude-chat' &&
        record?.transport === 'events' &&
        record?.launchProfileId === 'chat:claude:restore-profile' &&
        record?.claudeSessionId === claudeSessionId,
      record
    )
    if (!record) throw new Error('no chat record after launch 1: nothing to restore')

    // ── Assertion 2: a normal quit keeps the record ──
    await app.close()
    app = null
    t.check('quit: the chat record survives app.close()', existsSync(recordPath(tabId)))

    // ── Launch 2: accept the restore prompt ──
    launched = await launchApp(DIR, { env, settleMs: 3000 })
    app = launched.app
    win = launched.win
    const restore = win.getByRole('button', { name: 'Restore', exact: true })
    const prompted = await until(() => restore.isVisible().catch(() => false))
    t.check('launch 2: the restore prompt is offered', !!prompted)
    if (!prompted) throw new Error('no restore prompt at launch 2')
    await restore.click()
    const back = await until(async () =>
      (await callMcp(app, 'list', {})).sessions.find((s) => s.id === tabId)
    )
    t.check('launch 2: a tab with the SAME session id is back in the renderer store', !!back, {
      tabId,
      store: (await callMcp(app, 'list', {})).sessions.map((s) => s.id)
    })
    const kernel = (await win.evaluate(() => window.electronAPI.sessionsList())).find(
      (s) => s.id === tabId
    )
    t.check(
      'launch 2: and it is a claude-chat events session again, not a terminal',
      kernel?.adapterId === 'claude-chat' && kernel?.transport === 'events',
      kernel
    )
    // The resume replays the transcript into the view before any new input.
    const replayed = await until(
      async () =>
        (await win.getByTestId('chat-view').count()) > 0 &&
        (await win.getByTestId('chat-view').first().innerText()).includes(FIRST_PROMPT)
    )
    t.check('launch 2: the restored chat view shows the first conversation', !!replayed)

    // The CLI starts on first input: send one and read the argv it got.
    const before = launches().length
    await win.evaluate(
      async ({ id, text }) => {
        await window.electronAPI.sessionsSubscribe(id)
        await window.electronAPI.sessionsWrite(id, { type: 'user_message', text })
      },
      { id: tabId, text: SECOND_PROMPT }
    )
    const started = await until(() => launches().length > before)
    const resumed = launches().at(-1)
    if (resumed) pids.add(resumed.pid)
    t.check('launch 2: the restored tab started the CLI on its first message', !!started)
    t.equal(
      'launch 2: the saved launch profile arguments reach the restored process',
      argAfter(resumed?.argv ?? [], '--profile'),
      'restored account'
    )
    t.check(
      'launch 2: the CLI was launched with --resume <claudeSessionId>',
      !!started && argAfter(resumed.argv, '--resume') === claudeSessionId,
      resumed?.argv
    )
    t.check(
      'launch 2: and not as a fresh --session-id conversation',
      !!started && !resumed.argv.includes('--session-id'),
      resumed?.argv
    )

    // ── Assertion 4: a real close forgets the tab ──
    t.check('launch 2: the restored tab still has its record', existsSync(recordPath(tabId)))
    await callMcp(app, 'closeSession', { sessionId: tabId })
    const gone = await until(() => !existsSync(recordPath(tabId)))
    t.check('close: the chat record is discarded on a real close', !!gone, recordPath(tabId))
    t.check(
      'close: the tab left the renderer store',
      !(await callMcp(app, 'list', {})).sessions.some((s) => s.id === tabId)
    )
  } finally {
    if (app) await app.close()
    // Only the stub processes this spec recorded are ours to kill, by PID.
    for (const { pid } of launches()) pids.add(pid)
    for (const pid of pids) {
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
