// A tab goes from its chat to its terminal and back on the same conversation
// (lane D, PRDCT-4427). A Claude chat on a stub `claude` CLI (the fixture of
// chat-provider-switch: it records its argv and writes the transcript
// `--resume` reads) answers one message; the pane menu's « Terminal » tile
// restarts the SAME tab as a Claude terminal resuming that conversation
// (`--resume <id>` on the new process), its record replaced by a terminal's
// under the same id; the terminal pane's menu then offers the chat views, and
// « Chat » brings the tab back as a chat with the conversation replayed from
// the transcript, the record a chat's again under the same id and the same
// Claude session. A plain terminal's menu offers no move at all. Pinned to
// the in-process server like chat-provider-switch: the stub is found on the
// PATH the app was launched with. tmux is off for the run: a terminal on the
// shared tmux socket would take the server's PATH, not the stub's.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const DIR = userDataDir('chat-terminal-switch')
const ROOT = fixturePath('chat-terminal-switch-root')
const PROVIDER_HOMES = {
  CLAUDE_CONFIG_DIR: path.join(ROOT, 'provider-homes/claude'),
  CODEX_HOME: path.join(ROOT, 'provider-homes/codex'),
  PI_CODING_AGENT_DIR: path.join(ROOT, 'provider-homes/pi')
}
const TRANSCRIPTS = fixturePath('chat-terminal-switch-transcripts')
const PROCESSES = path.join(ROOT, 'processes.jsonl')
const INPUTS = path.join(ROOT, 'inputs.jsonl')
const WS = { id: 'switch-ws', name: 'Switch', rootDir: ROOT, profileFile: null, createdAt: 1 }

function writeFixtures() {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(TRANSCRIPTS, { recursive: true, force: true })
  mkdirSync(`${ROOT}/bin`, { recursive: true })
  mkdirSync(TRANSCRIPTS, { recursive: true })
  for (const home of Object.values(PROVIDER_HOMES)) mkdirSync(home, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(
    `${ROOT}/bin/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  // The stub CLI records its argv and every message, answers each, and
  // writes the transcript `--resume` would read. In a terminal it reads
  // nothing and stays up, as the real CLI waits at its prompt.
  writeFileSync(
    `${ROOT}/bin/claude`,
    `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const readline = require('node:readline');
const argv = process.argv.slice(2);
if (argv.includes('-p') && !argv.includes('--input-format')) { process.stdout.write('fixture title\\n'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(PROCESSES)}, JSON.stringify({ pid: process.pid, argv }) + '\\n');
const at = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null;
const sid = at('--resume') || at('--session-id');
const transcript = path.join(process.env.CLAVE_TRANSCRIPTS_ROOT, ${JSON.stringify(ROOT)}.replace(/[^a-zA-Z0-9]/g, '-'), sid + '.jsonl');
const emit = (f) => process.stdout.write(JSON.stringify(f) + '\\n');
const record = (line) => { fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.appendFileSync(transcript, JSON.stringify({ sessionId: sid, cwd: ${JSON.stringify(ROOT)}, timestamp: new Date().toISOString(), ...line }) + '\\n'); };
if (!argv.includes('--input-format')) { process.stdout.write('stub claude terminal ' + (sid || '') + '\\r\\n'); setInterval(() => {}, 1000); return; }
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  if (input.type === 'control_request' && input.request?.subtype === 'initialize') {
    emit({ type: 'control_response', response: { request_id: input.request_id, subtype: 'success', response: { commands: [], models: [] } } });
    return;
  }
  if (input.type !== 'user') return;
  const content = input.message.content;
  fs.appendFileSync(${JSON.stringify(INPUTS)}, JSON.stringify({ content }) + '\\n');
  record({ type: 'user', message: { role: 'user', content } });
  emit({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5' });
  const answer = 'ANSWER FROM STUB to ' + content;
  record({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: answer }] } });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] }, session_id: sid });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid });
});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 }
  )
}

const lines = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

/** Every session record in a user-data folder that carries this tab's id
 *  (a chat's is keyed by its id, a tmux terminal's by its tmux name). */
function recordsOf(userData, id) {
  const dir = path.join(userData, 'session-records')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')))
    .filter((record) => record.id === id)
}

export async function run(t) {
  writeFixtures()
  const env = {
    ...PROVIDER_HOMES,
    SHELL: `${ROOT}/bin/bash`,
    PATH: `${ROOT}/bin:${process.env.PATH}`,
    CLAVE_TRANSCRIPTS_ROOT: TRANSCRIPTS
  }
  const { app, win } = await launchApp(DIR, {
    server: 'in-process',
    args: ['--test-no-machine-usage'],
    env
  })
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    await win.evaluate(() => window.electronAPI.preferencesSet('tmuxMode', false))
    await until(async () => {
      try {
        return await callMcp(app, 'list', {})
      } catch {
        return false
      }
    })
    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    const folders = [...new Set([userData, DIR])]
    const records = (id) => folders.flatMap((folder) => recordsOf(folder, id))
    const tile = (id) => win.locator(`[data-terminal-tile="${id}"]`)
    const pane = (id) => win.locator(`.chat-host[data-session-id="${id}"]`)
    const chat = (id) => pane(id).locator('[data-testid="chat-view"]').first()
    const isTerminalPane = async (id) =>
      (await pane(id).count()) === 0 && (await tile(id).locator('.xterm').count()) > 0

    // ── 1. A Claude chat answers one message ──
    const opened = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      profile: 'claude-chat',
      name: 'Switching'
    })
    const id = opened.sessionId
    await callMcp(app, 'focus', { sessionId: id })
    await chat(id).waitFor({ timeout: 20_000 })
    await win.evaluate(
      async ({ id }) =>
        window.electronAPI.sessionsWrite(id, { type: 'user_message', text: 'first question' }),
      { id }
    )
    await chat(id).getByText('ANSWER FROM STUB to first question').waitFor({ timeout: 15_000 })
    t.check('the chat answered on the stub', lines(INPUTS).length === 1, lines(INPUTS))
    const chatRecord = await until(async () => records(id).find((r) => r.claudeSessionId))
    const conversation = chatRecord?.claudeSessionId
    t.check(
      'the chat tab has a chat record with its Claude session',
      chatRecord?.adapterId === 'claude-chat' &&
        chatRecord?.transport === 'events' &&
        !!conversation,
      records(id)
    )

    // ── 2. « Terminal »: the same tab restarts as a Claude terminal resuming it ──
    const before = lines(PROCESSES).length
    await pane(id).getByLabel('Session menu', { exact: true }).click()
    const terminalTile = win.locator('.view-tile[data-transport="pty"]')
    await terminalTile.waitFor()
    const chatTiles = await win.locator('.view-tile .view-tile-name').allInnerTexts()
    t.check(
      'the chat’s menu offers its views and the terminal',
      chatTiles.join(',') === 'Chat,Enclave,Folio,Terminal',
      chatTiles
    )
    await win.waitForTimeout(300)
    await terminalTile.click({ force: true })
    const becameTerminal = await until(() => isTerminalPane(id), { tries: 80 })
    t.check('the pane is now a terminal pane', !!becameTerminal)
    const terminalProcess = await until(
      async () =>
        lines(PROCESSES)
          .slice(before)
          .find((p) => !p.argv.includes('--input-format')),
      { tries: 80 }
    )
    const argv = terminalProcess?.argv ?? []
    t.check(
      'the new process is the Claude CLI resuming the chat’s conversation',
      argv[argv.indexOf('--resume') + 1] === conversation,
      argv
    )
    const listedAsTerminal = (await callMcp(app, 'list', {})).sessions.find((s) => s.id === id)
    t.check(
      'the tab keeps its id and its name',
      listedAsTerminal?.name === 'Switching',
      listedAsTerminal
    )
    const ptyRecords = await until(async () => {
      const found = records(id)
      return found.length === 1 && found[0].adapterId === 'pty' ? found : null
    })
    t.check(
      'the chat record is replaced by a terminal record under the same id',
      !!ptyRecords &&
        ptyRecords[0].transport === 'pty' &&
        ptyRecords[0].claudeSessionId === conversation,
      records(id)
    )

    // ── 3. « Chat » on the terminal: back to the chat, the conversation replayed ──
    await tile(id).getByLabel('Terminal session menu', { exact: true }).click()
    const ptyTiles = await until(async () => {
      const names = await win.locator('.view-tile .view-tile-name').allInnerTexts()
      return names.length ? names : null
    })
    t.check(
      'the terminal’s menu offers the chat views and itself',
      ptyTiles?.join(',') === 'Chat,Enclave,Folio,Terminal',
      ptyTiles
    )
    t.check(
      'the terminal tile is the selected one',
      (await win.locator('.view-tile[data-transport="pty"]').getAttribute('data-selected')) ===
        'true'
    )
    const chatTile = win
      .locator('.view-tile[data-transport="events"]')
      .filter({ has: win.locator('.view-tile-name', { hasText: /^Chat$/ }) })
    await win.waitForTimeout(300)
    await chatTile.click({ force: true })
    await chat(id).waitFor({ timeout: 20_000 })
    t.check('the pane is the chat view again', (await pane(id).count()) === 1)
    const replayed = await until(
      async () => {
        const text = await chat(id).innerText()
        return /first question/.test(text) && /ANSWER FROM STUB to first question/.test(text)
          ? text
          : null
      },
      { tries: 60 }
    )
    t.check(
      'the conversation shows the message and the answer, replayed from the transcript',
      !!replayed,
      (await chat(id).innerText()).slice(0, 600)
    )
    const backRecords = await until(async () => {
      const found = records(id)
      return found.length === 1 && found[0].adapterId === 'claude-chat' ? found : null
    })
    t.check(
      'the record is a chat record under the same id, on the same Claude session',
      !!backRecords && backRecords[0].claudeSessionId === conversation,
      records(id)
    )
    t.check('the stub got no message twice', lines(INPUTS).length === 1, lines(INPUTS))

    // ── 4. A plain terminal's menu has no « View as » ──
    const plain = await callMcp(app, 'openSession', { mode: 'terminal', cwd: ROOT, name: 'Plain' })
    await callMcp(app, 'focus', { sessionId: plain.sessionId })
    await tile(plain.sessionId).locator('.xterm').waitFor({ timeout: 20_000 })
    await tile(plain.sessionId).getByLabel('Terminal session menu', { exact: true }).click()
    const menu = win.locator('[role="menu"][aria-label="Session menu"]')
    await menu.waitFor()
    t.check(
      'a plain terminal’s menu has no « View as » section',
      (await menu.getByText('View as', { exact: true }).count()) === 0 &&
        (await menu.locator('.view-tile').count()) === 0,
      await menu.innerText()
    )
    await win.keyboard.press('Escape')
    t.check('no renderer error during the run', errors.length === 0, errors)
  } finally {
    await app.close()
  }
}
