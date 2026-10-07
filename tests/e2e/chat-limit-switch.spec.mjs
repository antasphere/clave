// Pinned to the in-process server (wave 2 of the server/client split,
// PRDCT-3239): this spec starts a session through the app, and a standalone
// server refuses every start until its terminal process exists (wave 3);
// the shared attached-mode fixture seam comes with it. Not a known failure.
// A chat tab whose account runs out of credits comes back on the next
// account (ADR 0002). The CLI in `-p` mode does not report that limit as a
// rate-limit event: it writes a synthetic reply in the model's place ("You're
// out of usage credits…") and ends its process — on 2026-09-26 the tab was
// left on "Session ended (exit 143)" with a disabled composer. Now the reply
// is read as the CLI's report, the dead tab is restarted on the next account
// with the conversation resumed, and the message the limit rejected is sent
// again, so the reader gets the answer they asked for without doing a thing
// (automatic mode) or with one click in the pane (propose mode).
//
// The checks are what the stub CLI's own processes record — the token they
// got, the `--resume` they were given, the messages they received — never a
// badge: a dropped spawn field renders a perfect UI on the wrong account.
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

const DIR = userDataDir('chat-limit-switch')
const ROOT = fixturePath('chat-limit-root')
const TRANSCRIPTS = fixturePath('chat-limit-transcripts')
const PROCESSES = path.join(ROOT, 'processes.jsonl')
const INPUTS = path.join(ROOT, 'inputs.jsonl')
const WS = { id: 'limit-ws', name: 'Limit', rootDir: ROOT, profileFile: null, createdAt: 1 }
const WORK_TOKEN = 'sk-ant-oat01-work-token-out-of-credits-0123456789'
const PLAY_TOKEN = 'sk-ant-oat01-play-token-with-headroom-0123456789'
const LIMIT_REPLY =
  "You're out of usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue."

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
  // The stub CLI: on the Work token it answers the first message the way the
  // real CLI did on 2026-09-26 (the synthetic reply, then exit 143); on the
  // Play token it answers. Every process records its argv and token, every
  // message it gets, and writes the transcript `--resume` is looked up in.
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
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  if (input.type !== 'user') return;
  const content = input.message.content;
  fs.appendFileSync(${JSON.stringify(INPUTS)}, JSON.stringify({ token, content }) + '\\n');
  record({ type: 'user', message: { role: 'user', content } });
  emit({ type: 'system', subtype: 'init', session_id: sid, model: 'stub' });
  if (token === ${JSON.stringify(WORK_TOKEN)}) {
    const message = { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(LIMIT_REPLY)} }] };
    record({ type: 'assistant', message });
    emit({ type: 'assistant', message, session_id: sid });
    emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid });
    setTimeout(() => process.exit(143), 300);
    return;
  }
  const answer = 'ANSWER FROM PLAY to ' + content;
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
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    // The usage probe answers per token with headroom on both, so the pool
    // holds two usable accounts; the Default (machine login) is never read.
    await app.evaluate(
      ({ ipcMain }, { WORK_TOKEN, PLAY_TOKEN }) => {
        const handlers = ipcMain._invokeHandlers
        const original = handlers.get('usage:get-limits')
        handlers.set('usage:get-limits', (event, accountId, options) => {
          if (!accountId || accountId === 'default') {
            return {
              windows: [
                {
                  key: 'session:x',
                  label: 'session',
                  kind: 'session',
                  scope: null,
                  usedPercentage: 30,
                  resetsAt: Date.now() + 3600_000,
                  severity: null
                }
              ],
              fetchedAt: Date.now()
            }
          }
          return original(event, accountId, options)
        })
        const quota = { [WORK_TOKEN]: 0.4, [PLAY_TOKEN]: 0.2 }
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
    const accounts = await win.evaluate(
      async ({ WORK_TOKEN, PLAY_TOKEN }) => {
        await window.electronAPI.launchProfileSetGlobal('claude', 'claude-chat')
        const work = await window.electronAPI.claudeAccountAdd({ label: 'Work' })
        await window.electronAPI.claudeAccountSetToken(work.id, WORK_TOKEN)
        const play = await window.electronAPI.claudeAccountAdd({ label: 'Play' })
        await window.electronAPI.claudeAccountSetToken(play.id, PLAY_TOKEN)
        await window.electronAPI.preferencesSet('accountSwitchMode', 'automatic')
        return { work: work.id, play: play.id }
      },
      { WORK_TOKEN, PLAY_TOKEN }
    )
    const ready = async () => {
      await win.waitForSelector('.sidebar-footer-line[data-usage-provider="claude"]')
      await until(async () => {
        try {
          return await callMcp(app, 'list', {})
        } catch {
          return false
        }
      })
    }
    await win.reload()
    await ready()
    const listed = async (sessionId) =>
      (await callMcp(app, 'list', {})).sessions.find((s) => s.id === sessionId)
    const processesOf = (token) => lines(PROCESSES).filter((p) => p.token === token)
    const inputsOf = (token) => lines(INPUTS).filter((p) => p.token === token)
    const record = (sessionId) =>
      JSON.parse(readFileSync(path.join(DIR, 'session-records', `${sessionId}.json`), 'utf8'))

    /** Open a chat tab on Work and send it one message: the Work process
     *  answers with the limit and ends. Returns the tab and its message. */
    const askOnWork = async (name, text) => {
      const opened = await callMcp(app, 'openSession', {
        cwd: ROOT,
        mode: 'claude',
        profile: 'claude-chat',
        account: 'Work',
        name
      })
      await callMcp(app, 'focus', { sessionId: opened.sessionId })
      await win.locator(`[data-testid="chat-view"]`).first().waitFor()
      await win.evaluate(
        async ({ id, text }) =>
          window.electronAPI.sessionsWrite(id, { type: 'user_message', text }),
        { id: opened.sessionId, text }
      )
      const asked = await until(() => inputsOf(WORK_TOKEN).find((i) => i.content === text))
      t.check(`${name}: the Work process got the message`, !!asked, lines(INPUTS))
      return opened.sessionId
    }

    // ── Automatic mode: the tab comes back on Play by itself, and answers ──
    const auto = await askOnWork('Automatic', 'first question')
    const workProcess = processesOf(WORK_TOKEN)[0]
    const claudeSessionId = workProcess?.argv[workProcess.argv.indexOf('--session-id') + 1]
    t.check('the Work process was started as a fresh conversation', !!claudeSessionId, workProcess)
    const revived = await until(() => processesOf(PLAY_TOKEN)[0] ?? null, { tries: 80, gapMs: 250 })
    t.check('a second process started on the Play token', !!revived, lines(PROCESSES))
    t.check(
      'the Play process resumes the Work conversation',
      revived?.argv.includes('--resume') &&
        revived.argv[revived.argv.indexOf('--resume') + 1] === claudeSessionId,
      revived?.argv
    )
    const resent = await until(
      () => inputsOf(PLAY_TOKEN).find((i) => i.content === 'first question') ?? null,
      { tries: 40, gapMs: 250 }
    )
    t.check('the rejected message was sent again on Play', !!resent, lines(INPUTS))
    const onPlay = await until(async () => {
      const s = await listed(auto)
      return s?.alive && s.account?.label === 'Play' ? s : null
    })
    t.check('the same tab is alive on Play', !!onPlay, await listed(auto))
    t.equal('the record names Play for the next launch', record(auto).claudeProfileLabel, 'Play')
    await win.getByText('ANSWER FROM PLAY to first question').first().waitFor({ timeout: 10_000 })
    t.check('the answer reached the pane', true)
    t.equal(
      'the pane no longer says the session ended',
      await win.locator('[data-chat-ended]').count(),
      0
    )
    t.check(
      'the composer is open again',
      !(await win.locator('[data-testid="chat-view"] textarea').first().isDisabled())
    )

    // ── Propose mode: the pane says why and offers the move; one click ──
    await win.evaluate(() => window.electronAPI.preferencesSet('accountSwitchMode', 'propose'))
    await win.reload()
    await ready()
    const proposed = await askOnWork('Proposed', 'second question')
    const notice = win.locator('[data-chat-ended="limit"]')
    await notice.first().waitFor({ timeout: 10_000 })
    t.check(
      'the pane names the account that is out, not an exit code',
      /Work is out of usage credits/.test(await notice.first().textContent()),
      await notice.first().textContent()
    )
    const button = win.locator(`[data-chat-continue-on="${accounts.play}"]`)
    t.check('the pane offers to continue on Play', (await button.count()) === 1)
    t.equal('no Play process started before the click', processesOf(PLAY_TOKEN).length, 1)
    // A DOM click: the hidden test window never receives pointer events.
    await button.first().evaluate((b) => b.click())
    const resentAfterClick = await until(
      () => inputsOf(PLAY_TOKEN).find((i) => i.content === 'second question') ?? null,
      { tries: 40, gapMs: 250 }
    )
    t.check('the click moved the tab and resent the message', !!resentAfterClick, lines(INPUTS))
    await win.getByText('ANSWER FROM PLAY to second question').first().waitFor({ timeout: 10_000 })
    const movedByHand = await listed(proposed)
    t.check(
      'the proposed tab is alive on Play',
      movedByHand?.alive && movedByHand.account?.label === 'Play',
      movedByHand
    )

    t.check('no renderer error during the run', errors.length === 0, errors)
  } finally {
    await app.close().catch(() => {})
  }
}
