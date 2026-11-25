// A tab starts with its writing style (PRDCT-5166), proved on what the agent
// PROCESS received, never on the options the launch was called with. A
// default style is seeded in the instance's `writing-styles.json`; a stub
// `claude` on the PATH records its argv. A Claude terminal tab and a Claude
// chat each start with the style's text in `--append-system-prompt` and the
// output style reset in their `--settings`; a tab opened with
// `writingStyle: 'none'` receives neither, and its record names no style.
// Pinned to the in-process server like chat-terminal-switch: the stub is
// found on the PATH the app was launched with. tmux is off for the run: a
// terminal on the shared tmux socket would take the server's PATH.
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

const DIR = userDataDir('writing-style-launch')
const ROOT = fixturePath('writing-style-launch-root')
const PROCESSES = path.join(ROOT, 'processes.jsonl')
const WS = { id: 'style-ws', name: 'Style', rootDir: ROOT, profileFile: null, createdAt: 1 }
// A made-up style whose text carries what a shell or a JSON layer could
// break: two lines, double quotes, backticks and a dollar sign.
const STYLE = {
  id: 'e2e-plain',
  name: 'E2E plain',
  description: 'A style the run seeds.',
  text: 'Write plainly.\nSay "done" once `npm test` passes, never $HOME.',
  statusCard: false
}

function writeFixtures() {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(`${ROOT}/bin`, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  // The machine's styles, the default among them, as the store keeps them
  // in the instance's data folder (`src/main/writing-styles/store.ts`).
  writeFileSync(
    path.join(DIR, 'writing-styles.json'),
    JSON.stringify({ version: 1, styles: [STYLE], defaultStyleId: STYLE.id })
  )
  writeFileSync(
    `${ROOT}/bin/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  // The stub records its argv with the tab it runs for. In a terminal it
  // stays up as the real CLI waits at its prompt; in a chat it answers the
  // initialize request and each message. The title one-shot answers a title.
  writeFileSync(
    `${ROOT}/bin/claude`,
    `#!${process.execPath}
const fs = require('node:fs'); const readline = require('node:readline');
const argv = process.argv.slice(2);
if (argv.includes('-p') && !argv.includes('--input-format')) { process.stdout.write('fixture title\\n'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(PROCESSES)}, JSON.stringify({ tab: process.env.CLAVE_SESSION_ID, argv }) + '\\n');
if (!argv.includes('--input-format')) { process.stdout.write('stub claude terminal\\r\\n'); setInterval(() => {}, 1000); return; }
const at = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null;
const sid = at('--resume') || at('--session-id');
const emit = (f) => process.stdout.write(JSON.stringify(f) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  if (input.type === 'control_request' && input.request?.subtype === 'initialize') {
    emit({ type: 'control_response', response: { request_id: input.request_id, subtype: 'success', response: { commands: [], models: [] } } });
    return;
  }
  if (input.type !== 'user') return;
  emit({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5' });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'STUB ANSWER' }] }, session_id: sid });
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

function recordsOf(userData, id) {
  const dir = path.join(userData, 'session-records')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')))
    .filter((record) => record.id === id)
}

/** What a process was handed: its system prompt and its settings, parsed. */
function received(argv) {
  const at = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
  let settings = null
  try {
    settings = JSON.parse(at('--settings') ?? 'null')
  } catch {
    settings = 'unparsable'
  }
  return { systemPrompt: at('--append-system-prompt'), settings }
}

export async function run(t) {
  writeFixtures()
  const { app, win } = await launchApp(DIR, {
    server: 'in-process',
    args: ['--test-no-machine-usage'],
    env: { SHELL: `${ROOT}/bin/bash`, PATH: `${ROOT}/bin:${process.env.PATH}` }
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
    const records = (id) => [...new Set([userData, DIR])].flatMap((dir) => recordsOf(dir, id))
    const processOf = (id) =>
      until(async () => lines(PROCESSES).find((p) => p.tab === id), { tries: 80 })
    const pane = (id) => win.locator(`.chat-host[data-session-id="${id}"]`)
    const chat = (id) => pane(id).locator('[data-testid="chat-view"]').first()

    // ── 1. A Claude terminal tab on the machine's default ──
    const terminal = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      name: 'Styled terminal'
    })
    await callMcp(app, 'focus', { sessionId: terminal.sessionId })
    const terminalProcess = await processOf(terminal.sessionId)
    const fromTerminal = received(terminalProcess?.argv ?? [])
    t.check(
      'the terminal process got the style, byte for byte, in --append-system-prompt',
      fromTerminal.systemPrompt === STYLE.text,
      terminalProcess?.argv
    )
    t.check(
      'the terminal process got the output style reset in its --settings',
      fromTerminal.settings?.outputStyle === 'default' && !!fromTerminal.settings?.hooks,
      fromTerminal.settings
    )
    t.check(
      "the terminal tab's record names the style",
      records(terminal.sessionId).some((r) => r.writingStyle === STYLE.id),
      records(terminal.sessionId)
    )

    // ── 2. A Claude chat on the machine's default ──
    const opened = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      profile: 'claude-chat',
      name: 'Styled chat'
    })
    await callMcp(app, 'focus', { sessionId: opened.sessionId })
    await chat(opened.sessionId).waitFor({ timeout: 20_000 })
    await win.evaluate(
      async ({ id }) =>
        window.electronAPI.sessionsWrite(id, { type: 'user_message', text: 'hello' }),
      { id: opened.sessionId }
    )
    const chatProcess = await processOf(opened.sessionId)
    const fromChat = received(chatProcess?.argv ?? [])
    t.check(
      'the chat process got the style in --append-system-prompt',
      fromChat.systemPrompt === STYLE.text,
      chatProcess?.argv
    )
    t.check(
      'the chat process got the output style reset in its --settings',
      fromChat.settings?.outputStyle === 'default',
      fromChat.settings
    )
    t.check(
      "the chat's record names the style",
      records(opened.sessionId).some((r) => r.writingStyle === STYLE.id),
      records(opened.sessionId)
    )

    // ── 3. A tab opened on no style receives neither ──
    const bare = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      name: 'No style',
      writingStyle: 'none'
    })
    await callMcp(app, 'focus', { sessionId: bare.sessionId })
    const bareProcess = await processOf(bare.sessionId)
    const fromBare = received(bareProcess?.argv ?? [])
    t.check(
      'a tab on no style is started without --append-system-prompt',
      !!bareProcess && fromBare.systemPrompt === undefined,
      bareProcess?.argv
    )
    t.check(
      'a tab on no style keeps the person’s output style',
      !!fromBare.settings && !('outputStyle' in fromBare.settings),
      fromBare.settings
    )
    t.check(
      'a tab on no style has a record naming none',
      records(bare.sessionId).length > 0 &&
        records(bare.sessionId).every((r) => r.writingStyle === undefined),
      records(bare.sessionId)
    )
    t.check('no renderer error during the run', errors.length === 0, errors)
  } finally {
    await app.close()
  }
}
