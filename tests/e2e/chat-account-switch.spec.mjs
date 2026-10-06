// Pinned to the in-process server (wave 2 of the server/client split,
// PRDCT-3239): this spec starts a session through the app, and a standalone
// server refuses every start until its terminal process exists (wave 3);
// the shared attached-mode fixture seam comes with it. Not a known failure.
// A live chat tab moved to another account by hand stays a live chat tab
// (ADR 0002). On 2026-09-28 a Claude chat tab moved while idle came back as
// "Session ended (exit 1)" with a disabled composer: the old process's exit —
// the signal the move stopped it with, read as 1 — was taken for the end of
// the tab. `chat-limit-switch` covers a tab whose process had already died of
// its limit; this one covers the process the move itself stops.
//
// The checks are what the stub CLI's own processes record — the token they
// got, the `--resume` they were given, the messages they received — plus the
// pane: no ended notice, the composer open, a new message answered.
//
// Pinned to the in-process server (`server: 'in-process'`): the quota it shows
// comes from a read stubbed on the shell's settings source
// (`globalThis.__claveE2E.settings`), which only the in-process server consults;
// an attached app answers its settings from the standalone server's own data
// directory, where no fixture in this process reaches. The attached-mode
// fixture seam is wave 3's, beside the Node terminal process (the wave's
// ruling of 6 October 2026).
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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

const DIR = userDataDir('chat-account-switch')
const ROOT = fixturePath('chat-switch-root')
const TRANSCRIPTS = fixturePath('chat-switch-transcripts')
const PROCESSES = path.join(ROOT, 'processes.jsonl')
const INPUTS = path.join(ROOT, 'inputs.jsonl')
const WS = { id: 'switch-ws', name: 'Switch', rootDir: ROOT, profileFile: null, createdAt: 1 }
const WORK_TOKEN = 'sk-ant-oat01-work-token-with-headroom-0123456789'
const PLAY_TOKEN = 'sk-ant-oat01-play-token-with-headroom-0123456789'

function writeFixtures() {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(TRANSCRIPTS, { recursive: true, force: true })
  mkdirSync(`${ROOT}/bin`, { recursive: true })
  mkdirSync(TRANSCRIPTS, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(
    `${ROOT}/bin/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  // The stub CLI answers on either token and stays up until it is signalled,
  // as the real one does between turns. Every process records its argv and
  // token, every message it gets, and writes the transcript `--resume` reads.
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
const record = (line) => { fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.appendFileSync(transcript, JSON.stringify(line) + '\\n'); };
const name = token === ${JSON.stringify(PLAY_TOKEN)} ? 'PLAY' : 'WORK';
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  if (input.type !== 'user') return;
  const content = input.message.content;
  fs.appendFileSync(${JSON.stringify(INPUTS)}, JSON.stringify({ token, content }) + '\\n');
  record({ type: 'user', message: { role: 'user', content } });
  emit({ type: 'system', subtype: 'init', session_id: sid, model: 'stub' });
  const answer = 'ANSWER FROM ' + name + ' to ' + content;
  record({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } });
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
    SHELL: `${ROOT}/bin/bash`,
    PATH: `${ROOT}/bin:${process.env.PATH}`,
    CLAVE_TRANSCRIPTS_ROOT: TRANSCRIPTS
  }
  const { app, win } = await launchApp(DIR, { server: 'in-process', env })
  // The old process's end (below) travels through the session host, and a
  // wrap only reaches the subscriptions made after it: so the host's stream is
  // wrapped here, before the tab exists, and asks a hold the move installs
  // later whether to keep a frame back. The exit is not held: the server's
  // push hub drops a session's subscription on its exit listener, so holding
  // that listener in main kept the hub bound to the killed process, and the
  // pane's re-subscribe joined that stale subscription and never saw Play.
  await app.evaluate(() => {
    globalThis.__endHold = null
    const host = globalThis.__claveE2E.sessionHost
    const subscribe = host.subscribe
    host.subscribe = (sid, listener) =>
      subscribe.call(host, sid, (frame) => {
        const end = frame?.kind === 'event' && frame.event?.state === 'ended'
        if (!(end && globalThis.__endHold?.(sid, () => listener(frame)))) listener(frame)
      })
  })
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    // Both accounts have headroom: the move is the reader's choice, not a limit's.
    await app.evaluate(
      (_electron, { WORK_TOKEN, PLAY_TOKEN }) => {
        const settings = globalThis.__claveE2E?.settings
        if (!settings) throw new Error('no settings source: is --test-no-activate on?')
        const original = settings.usage.readClaude
        settings.usage.readClaude = async (accountId, force) => {
          if (accountId === undefined || accountId === 'default')
            return { windows: [], fetchedAt: Date.now() }
          return original(accountId, force)
        }
        const quota = { [WORK_TOKEN]: 0.3, [PLAY_TOKEN]: 0.2 }
        globalThis.fetch = async (_url, init) => {
          const token = (init?.headers?.Authorization ?? '').replace(/^Bearer /, '')
          const used = quota[token]
          if (used === undefined)
            return new Response('{}', {
              status: 401,
              headers: { 'content-type': 'application/json' }
            })
          return new Response('{}', {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'anthropic-ratelimit-unified-5h-utilization': String(used),
              'anthropic-ratelimit-unified-5h-reset': String(
                Math.floor(Date.now() / 1000) + 3 * 3600
              ),
              'anthropic-ratelimit-unified-5h-status': 'allowed'
            }
          })
        }
      },
      { WORK_TOKEN, PLAY_TOKEN }
    )
    await win.evaluate(
      async ({ WORK_TOKEN, PLAY_TOKEN }) => {
        await window.electronAPI.launchProfileSetGlobal('claude', 'claude-chat')
        const work = await window.electronAPI.claudeAccountAdd({ label: 'Work' })
        await window.electronAPI.claudeAccountSetToken(work.id, WORK_TOKEN)
        const play = await window.electronAPI.claudeAccountAdd({ label: 'Play' })
        await window.electronAPI.claudeAccountSetToken(play.id, PLAY_TOKEN)
        await window.electronAPI.preferencesSet('accountSwitchMode', 'automatic')
      },
      { WORK_TOKEN, PLAY_TOKEN }
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
    const listed = async (sessionId) =>
      (await callMcp(app, 'list', {})).sessions.find((s) => s.id === sessionId)
    const processesOf = (token) => lines(PROCESSES).filter((p) => p.token === token)
    const inputsOf = (token) => lines(INPUTS).filter((p) => p.token === token)
    const pane = (id) => win.locator(`.chat-host[data-session-id="${id}"]`)
    const chat = (id) => pane(id).locator('[data-testid="chat-view"]').first()

    const opened = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      profile: 'claude-chat',
      account: 'Work',
      name: 'Moved'
    })
    const id = opened.sessionId
    await callMcp(app, 'focus', { sessionId: id })
    await pane(id).locator('[data-testid="chat-view"]').waitFor()
    await win.evaluate(
      async ({ id }) =>
        window.electronAPI.sessionsWrite(id, { type: 'user_message', text: 'first question' }),
      { id }
    )
    await chat(id).getByText('ANSWER FROM WORK to first question').waitFor({ timeout: 10_000 })
    const work = processesOf(WORK_TOKEN)[0]
    const claudeSessionId = work?.argv[work.argv.indexOf('--session-id') + 1]
    t.check('the tab answered on Work first', !!claudeSessionId, lines(PROCESSES))

    // ── The move, by hand, on an idle live tab ──
    // Electron orders `send` messages among themselves but not against an
    // `invoke` reply, so the old process's end sometimes reaches the window
    // after the reply that remounts the pane — the order the reader hit, and
    // not one a run gets reliably on its own. Main here holds that end
    // (`ended` on the stream and the state channel, the exit) until just after
    // the restart has answered, so every run takes the late order.
    await app.evaluate(
      ({ ipcMain }, { id }) => {
        let restarting = false
        const held = []
        // The `agent:state` end is no longer held: that state travels as a
        // server event now, not through a channel main sends on.
        // Only the `ended` stream frame is held (see the host wrap above).
        globalThis.__endHold = (sid, flush) => {
          if (!restarting || sid !== id) return false
          held.push(flush)
          return true
        }
        const handlers = ipcMain._invokeHandlers
        const restart = handlers.get('pty:restart')
        handlers.set('pty:restart', async (...a) => {
          restarting = true
          try {
            return await restart(...a)
          } finally {
            restarting = false
            setTimeout(() => held.splice(0).forEach((flush) => flush()), 50)
          }
        })
      },
      { id }
    )
    const moved = await callMcp(app, 'switchAccount', { sessionId: id, account: 'Play' })
    t.check('the switch was made, not proposed', !!moved && !moved.proposed, moved)
    const revived = await until(() => processesOf(PLAY_TOKEN)[0] ?? null, { tries: 40, gapMs: 250 })
    t.check('a process started on the Play token', !!revived, lines(PROCESSES))
    t.check(
      'the Play process resumes the Work conversation',
      revived?.argv.includes('--resume') &&
        revived.argv[revived.argv.indexOf('--resume') + 1] === claudeSessionId,
      revived?.argv
    )
    // Long enough for the held end, and the check it goes through, to land.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    t.equal(
      'the pane does not say the session ended',
      await pane(id).locator('[data-chat-ended]').count(),
      0
    )
    const composer = chat(id).locator('textarea').first()
    t.check('the composer is open', !(await composer.isDisabled()))
    const onPlay = await listed(id)
    t.check('the tab is alive on Play', onPlay?.alive && onPlay.account?.label === 'Play', onPlay)

    await win.evaluate(
      async ({ id }) =>
        window.electronAPI.sessionsWrite(id, { type: 'user_message', text: 'second question' }),
      { id }
    )
    const asked = await until(
      () => inputsOf(PLAY_TOKEN).find((i) => i.content === 'second question') ?? null,
      { tries: 40, gapMs: 250 }
    )
    t.check('the next message reached the Play process', !!asked, lines(INPUTS))
    const answered = await chat(id)
      .getByText('ANSWER FROM PLAY to second question')
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    t.check('the answer reached the pane', answered)

    // ── A real end still reads as one: the Play process dies on its own ──
    process.kill(revived.pid, 'SIGTERM')
    const ended = await chat(id)
      .locator('[data-chat-ended="exit"]')
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    t.check('a process that really ends still ends the pane', ended)

    t.check('no renderer error during the run', errors.length === 0, errors)
  } finally {
    await app.close().catch(() => {})
  }
}
