// Pinned to the in-process server (wave 2 of the server/client split,
// PRDCT-3239): this spec starts a session through the app, and a standalone
// server refuses every start until its terminal process exists (wave 3);
// the shared attached-mode fixture seam comes with it. Not a known failure.
// The account chip on the Terminal view's status line: the account the tab
// runs on, what is left of it, and the menu that shows its caps and moves the
// tab to another account (the same menu a tab's right click opens).
//
// Work is past its cap the way the service reports it, utilization 1.01 and
// status rejected: until 2026-10-05 the probe read 1.01 as "1.01 percent"
// and an exhausted cap showed as 1% used beside a warning. The checks are
// what the chip and its menu say, then what the stub CLI's own processes
// record once a row is picked: the token they got.
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

const DIR = userDataDir('terminal-account-chip')
const ROOT = fixturePath('account-chip-root')
const TRANSCRIPTS = fixturePath('account-chip-transcripts')
const PROCESSES = path.join(ROOT, 'processes.jsonl')
const WS = { id: 'chip-ws', name: 'Chip', rootDir: ROOT, profileFile: null, createdAt: 1 }
const WORK_TOKEN = 'sk-ant-oat01-work-token-past-its-cap-0123456789'
const PLAY_TOKEN = 'sk-ant-oat01-play-token-with-headroom-0123456789'

function writeFixtures() {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(TRANSCRIPTS, { recursive: true, force: true })
  mkdirSync(`${ROOT}/bin`, { recursive: true })
  mkdirSync(TRANSCRIPTS, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  // New chats open in the Terminal view, as for a reader who picked it last.
  writeFileSync(`${DIR}/preferences.json`, JSON.stringify({ chatView: 'clave.chat-view/terminal' }))
  writeFileSync(
    `${ROOT}/bin/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  // A stub CLI that records the token each process got and stays up.
  writeFileSync(
    `${ROOT}/bin/claude`,
    `#!${process.execPath}
const fs = require('node:fs'); const readline = require('node:readline');
const argv = process.argv.slice(2);
if (argv.includes('-p') && !argv.includes('--input-format')) { process.stdout.write('fixture title\\n'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(PROCESSES)}, JSON.stringify({ pid: process.pid, argv, token: process.env.CLAUDE_CODE_OAUTH_TOKEN || '' }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', () => {});
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
        const reset = () => String(Math.floor(Date.now() / 1000) + 3 * 3600)
        const windows = {
          [WORK_TOKEN]: { utilization: '1.01', status: 'rejected', http: 429 },
          [PLAY_TOKEN]: { utilization: '0.2', status: 'allowed', http: 200 }
        }
        globalThis.fetch = async (_url, init) => {
          const token = (init?.headers?.Authorization ?? '').replace(/^Bearer /, '')
          const w = windows[token]
          if (!w) return new Response('{}', { status: 401 })
          return new Response('{}', {
            status: w.http,
            headers: {
              'content-type': 'application/json',
              'anthropic-ratelimit-unified-5h-utilization': w.utilization,
              'anthropic-ratelimit-unified-5h-reset': reset(),
              'anthropic-ratelimit-unified-5h-status': w.status
            }
          })
        }
      },
      { WORK_TOKEN, PLAY_TOKEN }
    )
    const ids = await win.evaluate(
      async ({ WORK_TOKEN, PLAY_TOKEN }) => {
        await window.electronAPI.launchProfileSetGlobal('claude', 'claude-chat')
        const work = await window.electronAPI.claudeAccountAdd({ label: 'Work' })
        await window.electronAPI.claudeAccountSetToken(work.id, WORK_TOKEN)
        const play = await window.electronAPI.claudeAccountAdd({ label: 'Play' })
        await window.electronAPI.claudeAccountSetToken(play.id, PLAY_TOKEN)
        return { work: work.id, play: play.id }
      },
      { WORK_TOKEN, PLAY_TOKEN }
    )
    await win.reload()
    await until(async () => {
      try {
        return await callMcp(app, 'list', {})
      } catch {
        return false
      }
    })

    const opened = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      profile: 'claude-chat',
      account: 'Work',
      name: 'Chip'
    })
    const id = opened.sessionId
    await callMcp(app, 'focus', { sessionId: id })
    const pane = win.locator(`.chat-host[data-session-id="${id}"]`)
    await pane.locator('.term-status').waitFor({ timeout: 10_000 })
    await until(() => lines(PROCESSES).some((p) => p.token === WORK_TOKEN))

    // ── The chip: Work, at its limit ──
    const chip = pane.locator(`.term-account[data-account-chip="${ids.work}"]`)
    await chip.waitFor()
    await until(async () => (await chip.getAttribute('data-level')) === 'critical', {
      tries: 40,
      gapMs: 250
    })
    t.equal(
      'the chip is on Work',
      await chip.locator('.chat-model-trigger-label').innerText(),
      'Work'
    )
    t.equal('the chip says Work is at its limit', await chip.getAttribute('data-level'), 'critical')
    t.equal(
      'the chip reads "At limit"',
      await chip.locator('.term-account-headroom').innerText(),
      'At limit'
    )

    // ── The menu: Work's caps, then Play to move to ──
    // The reload above leaves the restore offer up over the window; this
    // run starts fresh.
    const fresh = win.getByRole('button', { name: 'Start fresh' })
    if (await fresh.isVisible().catch(() => false)) await fresh.click()
    await chip.locator('button').click()
    const menu = win.locator('.term-account-menu')
    await menu.waitFor()
    t.check(
      "the header is Work's, exhausted",
      (await menu
        .locator(`[data-account-header="${ids.work}"]`)
        .getAttribute('data-account-exhausted')) === 'true'
    )
    t.equal(
      'a cap past its limit reads 100% used, not 1%',
      (await menu.locator('.usage-column-value').first().innerText()).trim(),
      '100%'
    )
    const playRow = menu.locator(`[data-account-switch-row="${ids.play}"]`)
    await playRow.waitFor()
    t.equal(
      'Play is offered with its headroom',
      await playRow.locator('.account-switch-left').innerText(),
      '80% left'
    )
    await playRow.hover()
    const preview = win.locator(`[data-account-preview="${ids.play}"]`)
    t.check(
      "Play's card shows beside its row",
      await preview
        .waitFor({ timeout: 3_000 })
        .then(() => true)
        .catch(() => false)
    )

    // ── The move ──
    await playRow.click()
    const revived = await until(
      () => lines(PROCESSES).find((p) => p.token === PLAY_TOKEN) ?? null,
      { tries: 40, gapMs: 250 }
    )
    t.check('picking Play started the agent on the Play token', !!revived, lines(PROCESSES))
    const moved = pane.locator(`.term-account[data-account-chip="${ids.play}"]`)
    const onPlay = await moved
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    t.check('the chip follows the tab to Play', onPlay)
    if (onPlay) {
      await until(
        async () => (await moved.locator('.term-account-headroom').innerText()) === '80% left',
        { tries: 40, gapMs: 250 }
      )
      t.equal(
        "the chip reads Play's headroom",
        await moved.locator('.term-account-headroom').innerText(),
        '80% left'
      )
      t.check('Play is not flagged', (await moved.getAttribute('data-level')) !== 'critical')
    }

    t.check('no renderer error during the run', errors.length === 0, errors)
  } finally {
    await app.close().catch(() => {})
  }
}
