// A chat tab moves to another provider (PRDCT-4300). A Claude chat on the
// stub CLI (the same fixture as chat-account-switch) picks a model of the
// Echo adapter in the chip's two-level menu; the popover says the move
// reconstructs the conversation and which road it takes (no converter to
// Echo: the handoff), and Continue restarts the SAME tab on the Echo adapter
// with the handoff as its first message, which the echo repeats, so the pane
// shows the header and the conversation's words. The record keeps the id,
// the Claude stub gets no further message, and the full tape is written
// beside the work. Pinned to the in-process server for the same reason as
// chat-account-switch (the stubbed settings source).
import assert from 'node:assert/strict'
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

const DIR = userDataDir('chat-provider-switch')
const ROOT = fixturePath('chat-provider-switch-root')
const PROVIDER_HOMES = {
  CLAUDE_CONFIG_DIR: path.join(ROOT, 'provider-homes/claude'),
  CODEX_HOME: path.join(ROOT, 'provider-homes/codex'),
  PI_CODING_AGENT_DIR: path.join(ROOT, 'provider-homes/pi')
}
const TRANSCRIPTS = fixturePath('chat-provider-switch-transcripts')
const PROCESSES = path.join(ROOT, 'processes.jsonl')
const INPUTS = path.join(ROOT, 'inputs.jsonl')
const WS = { id: 'move-ws', name: 'Move', rootDir: ROOT, profileFile: null, createdAt: 1 }
const WORK_TOKEN = 'sk-ant-oat01-work-token-with-headroom-0123456789'

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
  // writes the transcript `--resume` would read.
  writeFileSync(
    `${ROOT}/bin/claude`,
    `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const readline = require('node:readline');
const argv = process.argv.slice(2);
if (argv.includes('-p') && !argv.includes('--input-format')) { process.stdout.write('fixture title\\n'); process.exit(0); }
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
fs.appendFileSync(${JSON.stringify(PROCESSES)}, JSON.stringify({ pid: process.pid, argv, token }) + '\\n');
const at = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null;
const sid = at('--resume') || at('--session-id');
const transcript = path.join(process.env.CLAVE_TRANSCRIPTS_ROOT, ${JSON.stringify(ROOT)}.replace(/[^a-zA-Z0-9]/g, '-'), sid + '.jsonl');
const emit = (f) => process.stdout.write(JSON.stringify(f) + '\\n');
const record = (line) => { fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.appendFileSync(transcript, JSON.stringify({ sessionId: sid, cwd: ${JSON.stringify(ROOT)}, timestamp: new Date().toISOString(), ...line }) + '\\n'); };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  if (input.type !== 'user') return;
  const content = input.message.content;
  fs.appendFileSync(${JSON.stringify(INPUTS)}, JSON.stringify({ token, content }) + '\\n');
  record({ type: 'user', message: { role: 'user', content } });
  emit({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5' });
  const answer = 'ANSWER FROM WORK to ' + content;
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
    args: ['--test-no-machine-usage', '--dev-echo-adapter'],
    env
  })
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    await app.evaluate(
      (_electron, { WORK_TOKEN }) => {
        const settings = globalThis.__claveE2E?.settings
        if (!settings) throw new Error('no settings source: is --test-no-activate on?')
        const original = settings.usage.readClaude
        settings.usage.readClaude = async (accountId, force) => {
          if (accountId === undefined || accountId === 'default')
            return { windows: [], fetchedAt: Date.now() }
          return original(accountId, force)
        }
        globalThis.fetch = async (_url, init) => {
          const token = (init?.headers?.Authorization ?? '').replace(/^Bearer /, '')
          if (token !== WORK_TOKEN)
            return new Response('{}', {
              status: 401,
              headers: { 'content-type': 'application/json' }
            })
          return new Response('{}', {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'anthropic-ratelimit-unified-5h-utilization': '0.3',
              'anthropic-ratelimit-unified-5h-reset': String(
                Math.floor(Date.now() / 1000) + 3 * 3600
              ),
              'anthropic-ratelimit-unified-5h-status': 'allowed'
            }
          })
        }
      },
      { WORK_TOKEN }
    )
    await win.evaluate(
      async ({ WORK_TOKEN }) => {
        await window.electronAPI.launchProfileSetGlobal('claude', 'claude-chat')
        const work = await window.electronAPI.claudeAccountAdd({ label: 'Work' })
        await window.electronAPI.claudeAccountSetToken(work.id, WORK_TOKEN)
      },
      { WORK_TOKEN }
    )
    await win.reload()
    await win.waitForSelector('.sidebar-footer-line[data-usage-provider="claude"]')
    await until(async () => {
      try {
        return await callMcp(app, 'list', {})
      } catch {
        return false
      }
    })
    const pane = (id) => win.locator(`.chat-host[data-session-id="${id}"]`)
    const chat = (id) => pane(id).locator('[data-testid="chat-view"]').first()

    const opened = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      profile: 'claude-chat',
      account: 'Work',
      name: 'Moving'
    })
    const id = opened.sessionId
    await callMcp(app, 'focus', { sessionId: id })
    await chat(id).waitFor()
    await win.evaluate(
      async ({ id }) =>
        window.electronAPI.sessionsWrite(id, { type: 'user_message', text: 'first question' }),
      { id }
    )
    await chat(id).getByText('ANSWER FROM WORK to first question').waitFor({ timeout: 10_000 })
    const claudeInputs = lines(INPUTS).length
    t.check('the tab answered on Claude first', claudeInputs === 1, lines(INPUTS))
    await chat(id).locator('.chat-model-trigger').filter({ hasText: 'Claude · Opus 5.5' }).waitFor()
    t.check('the chip reads the provider, then the model', true)

    // ── The two-level menu: Echo's models under the Echo row ──
    await chat(id).getByRole('button', { name: 'Model', exact: true }).click()
    const echoRow = win.locator('.chat-model-provider[data-adapter="echo"]')
    await echoRow.waitFor()
    assert.equal(
      await win
        .locator('.chat-model-provider[data-adapter="claude-chat"]')
        .getAttribute('data-selected'),
      'true',
      "the tab's own provider reads selected"
    )
    await echoRow.click()
    await win.getByRole('menuitem', { name: /Echo 1/ }).click()

    // ── The popover, before anything moves ──
    const popover = chat(id).locator('section[data-kind="provider-switch"]')
    await popover.waitFor()
    const words = await popover.innerText()
    t.check(
      'the popover says the move reconstructs, not continues',
      /reconstructs/.test(words) && /does not continue it/.test(words),
      words
    )
    t.check(
      'it says what carries and what does not',
      /What carries/.test(words) && /What does not/.test(words) && /working memory/.test(words)
    )
    t.check(
      'it says where the move lands',
      /Where it lands/.test(words) && /Echo/.test(words) && /Echo 1/.test(words)
    )
    await until(async () => (await popover.getAttribute('data-road')) !== null)
    t.check(
      'it names the handoff road, since no converter to Echo exists',
      (await popover.getAttribute('data-road')) === 'handoff' &&
        /No converter exists/.test(await popover.innerText()),
      await popover.innerText()
    )
    const stillClaude = await win.evaluate(
      (id) =>
        window.__claveSessionStoreForTests?.getState().sessions.find((s) => s.id === id)
          ?.launchProfileId,
      id
    )
    t.check('nothing restarted before Continue', stillClaude === 'claude-chat', stillClaude)

    // ── Continue: the same tab, on Echo, opened on the handoff ──
    await popover.getByRole('button', { name: 'Continue', exact: true }).click()
    await chat(id).locator('.chat-continued-from').waitFor({ timeout: 20_000 })
    t.check(
      'the first card says where the conversation came from',
      /Continued from Claude · handoff/.test(
        await chat(id).locator('.chat-continued-from').innerText()
      )
    )
    // The echo repeats the handoff: its words are in the pane twice, as the
    // message and as the answer; the markdown heading loses its '#'.
    const intro = chat(id).getByText(/You are reading a transcript of it, not continuing it/)
    try {
      await intro.first().waitFor({ timeout: 15_000 })
    } catch {
      // Say what the pane held instead, for the record.
    }
    const echoed = await chat(id).innerText()
    t.check(
      'the echo got the handoff as its first message and repeated it',
      (await intro.count()) >= 1,
      echoed.slice(0, 1500)
    )
    t.check(
      'the handoff carries the conversation',
      /first question/.test(echoed) && /ANSWER FROM WORK to first question/.test(echoed)
    )
    t.check('it says the move does not continue the conversation', /not continuing it/.test(echoed))
    const moved = await win.evaluate((id) => {
      const s = window.__claveSessionStoreForTests?.getState().sessions.find((x) => x.id === id)
      return (
        s && {
          launchProfileId: s.launchProfileId,
          model: s.model,
          continuedFrom: s.continuedFrom,
          alive: s.alive
        }
      )
    }, id)
    t.check(
      'the same tab is now the echo adapter’s, on Echo 1, alive',
      moved?.launchProfileId === 'dev-echo-adapter' &&
        moved?.model === 'echo-1' &&
        moved?.alive === true,
      moved
    )
    t.check(
      'the store knows the conversation came from Claude as a handoff',
      moved?.continuedFrom?.provider === 'claude' && moved?.continuedFrom?.road === 'handoff',
      moved
    )
    // The chip names the provider at once and the model as the id reads
    // until the menu has been opened and named it (Echo has no table).
    const chipText = async () => chat(id).locator('.chat-model-trigger').first().innerText()
    const chipOk = await until(async () => /^Echo · (echo-1|Echo 1)$/.test(await chipText()))
    t.check('the chip reads the new provider and model', chipOk, await chipText())
    t.check(
      'the Claude stub got no further message',
      lines(INPUTS).length === claudeInputs,
      lines(INPUTS)
    )
    const listed = (await callMcp(app, 'list', {})).sessions.find((s) => s.id === id)
    t.check('the tab keeps its id and its name', !!listed && listed.name === 'Moving', listed)
    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    const tape = path.join(userData, 'handoffs', `${id}.md`)
    t.check(
      'the full conversation was written beside the work',
      existsSync(tape) && readFileSync(tape, 'utf8').includes('first question'),
      tape
    )
    t.check('no renderer error during the run', errors.length === 0, errors)
  } finally {
    await app.close()
  }
}
