/**
 * A restart keeps every stopped tab (PRDCT-4236).
 *
 * On 9 November 2026 a restart of Clave emptied the sidebar of every chat
 * tab. The road: an app whose main server is a Clave server (a daemon, the
 * kind that owns its sessions and refuses to start a stopped record on a
 * client's word, "Recover a tab's identity, never its process. Only restart
 * is Resume") brought its tabs back through the restore, which asked the
 * server to START each stopped record it placed, read the refusal as a
 * failed spawn and removed the tab. Every chat is stopped after a quit, so
 * every chat left the sidebar, in every workspace, at every boot.
 *
 * Part 1, the daemon road: a daemon holds a stopped chat record and a stopped
 * terminal record; an app attached to it as its main server boots. Both tabs
 * must be in the sidebar with their titles, stopped, no prompt asked and no
 * record discarded; the chat's pane reads the end and offers Resume; Resume
 * relaunches the CLI on the same conversation (`--resume <id>`), in the mode
 * the record kept, and the pane goes live.
 *
 * Part 2, the shipped default: the app's own separate server never refuses a
 * restore's start, so a stopped chat record there comes back as it always
 * did. Pinned here so the two roads stay distinguishable.
 *
 * Part 3, a refused start on the shipped in-process road (round 1, F3): a
 * dead Claude terminal record whose account is gone (no token for
 * `claudeProfileId`) is offered by the restore prompt; Restore asks for its
 * start and the spawn is refused before any process. The tab must stay in the
 * sidebar with its title and its record, and its Resume, which used to fail
 * with an unreadable `{ "id": … }` (the server knew no session of that id),
 * must re-run the spawn from the record and say WHY it failed again, in the
 * tab: `Resume failed: The selected Claude account is no longer available.`
 *
 * Fails if: the chat or the terminal row is missing after the boot (the
 * refusal removing the tab again), a record was discarded, a restore prompt
 * is shown for the daemon's records, Resume launches no CLI or launches it
 * without `--resume`, the separate server's restore loses the chat, the
 * refused start takes the tab or its record away, or its Resume shows no
 * reason or not the account's.
 * Nothing here reaches Anthropic: the daemon runs the Claude chat adapter on
 * the stream-json stand-in `fixtures/claude-stream-stub.mjs`; part 3's spawn
 * is refused before any process, and a stand-in `claude` first on PATH would
 * catch (and the spec would fail on) any CLI started anyway.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  REPO,
  launchApp,
  persistedWindows,
  seedWorkspaces,
  seedTrustedRoots,
  seedSessionRecord,
  recordsRootOf,
  userDataDir,
  fixturePath,
  until
} from './harness.mjs'

const CHAT_ID = '7a1d0c3e-0000-4000-8000-00000000c4a7'
const CHAT_CONVERSATION = '3afafb91-0000-4000-8000-0000000000c1'
const TERM_ID = '7a1d0c3e-0000-4000-8000-00000000c4b2'
const CHAT_TITLE = 'Odoo accounting research'
const TERM_TITLE = 'Build log'
const GONE_ID = '7a1d0c3e-0000-4000-8000-00000000c4c3'
const GONE_TMUX = 'clave-stopped-tabs-refused-g0ne'
const LATER_TOKEN = 'sk-ant-oat01-lane-token-for-the-e2e-run-0123456789abcdef'
/** The usage read a token brings is answered here, never by Anthropic. */
const stubUsageFetch = (app) =>
  app.evaluate(() => {
    const soon = String(Math.floor(Date.now() / 1000) + 3600)
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ type: 'message', content: [] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-5h-utilization': '0.1',
          'anthropic-ratelimit-unified-5h-reset': soon,
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'anthropic-ratelimit-unified-7d-utilization': '0.1',
          'anthropic-ratelimit-unified-7d-reset': soon,
          'anthropic-ratelimit-unified-7d-status': 'allowed',
          'anthropic-ratelimit-unified-status': 'allowed'
        }
      })
  })
const GONE_CONVERSATION = '3afafb91-0000-4000-8000-0000000000c3'
const GONE_TITLE = 'Account gone'

const lines = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

/** The stopped chat record as the app writes one, on the stub chat profile. */
const chatRecord = (root, ws, profile) => ({
  adapterId: 'claude-chat',
  transport: 'events',
  id: CHAT_ID,
  claudeSessionId: CHAT_CONVERSATION,
  cwd: root,
  folderName: path.basename(root),
  displayName: CHAT_TITLE,
  userRenamed: false,
  claudeMode: true,
  antigravityMode: false,
  codexMode: false,
  piMode: false,
  claudeAgentsMode: false,
  dangerousMode: false,
  model: 'claude-opus-5-5',
  launchProfileId: profile,
  workspaceId: ws,
  permissionMode: 'acceptEdits'
})

/** A plain terminal's record, stopped: no tmux name, a shell that is gone. */
const terminalRecord = (root, ws) => ({
  adapterId: 'pty',
  transport: 'pty',
  id: TERM_ID,
  cwd: root,
  folderName: path.basename(root),
  displayName: TERM_TITLE,
  userRenamed: true,
  claudeMode: false,
  antigravityMode: false,
  codexMode: false,
  piMode: false,
  claudeAgentsMode: false,
  dangerousMode: false,
  workspaceId: ws
})

/** The row's text, read from the DOM without waiting for it (a locator's
 *  textContent waits for the element, and a row that never comes would hold
 *  every poll for the action timeout). */
const rowText = (win, id) =>
  win
    .evaluate(
      (sid) => document.querySelector(`[data-sidebar-item-id="${sid}"]`)?.textContent ?? null,
      id
    )
    .catch(() => null)

export async function run(t) {
  // ── Part 1: the daemon road ──
  {
    const DIR = userDataDir('stopped-tabs-daemon')
    const ROOT = fixturePath('stopped-tabs-daemon-root')
    const TRANSCRIPTS = `${ROOT}/transcripts`
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(TRANSCRIPTS, { recursive: true })
    const WS = {
      id: 'c4a70000-0000-4000-8000-000000000001',
      name: 'Stopped tabs',
      rootDir: ROOT,
      profileFile: null,
      createdAt: 1
    }
    seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
    seedTrustedRoots(DIR, [ROOT])
    // The daemon's records: seeded into the app folder, copied into the
    // server's data folder when the harness starts it (`seedServerDataDir`).
    seedSessionRecord(DIR, chatRecord(ROOT, WS.id, 'chat:claude:stopped-tabs-stub'))
    seedSessionRecord(DIR, terminalRecord(ROOT, WS.id))
    // What the real CLI leaves behind after a turn, so the Resume has a
    // conversation to continue (a chat with no transcript relaunches fresh).
    const dashed = path.join(TRANSCRIPTS, ROOT.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dashed, { recursive: true })
    writeFileSync(
      path.join(dashed, `${CHAT_CONVERSATION}.jsonl`),
      JSON.stringify({
        type: 'user',
        sessionId: CHAT_CONVERSATION,
        uuid: '00000000-0000-4000-8000-000000000001',
        cwd: ROOT,
        message: { role: 'user', content: 'the first message, before the quit' }
      }) + '\n'
    )

    const launched = await launchApp(DIR, {
      server: 'attached',
      args: ['--daemon'],
      env: { CLAVE_TRANSCRIPTS_ROOT: TRANSCRIPTS }
    })
    const { app, win, server } = launched
    try {
      t.check('the app is attached to a daemon of its own', !!server?.url, server?.url)
      const recordFile = (id) => path.join(server.dataDir, 'session-records', `${id}.json`)
      t.check('the daemon holds the stopped chat record', existsSync(recordFile(CHAT_ID)))
      // The stub chat profile the record names, on the daemon: the Resume
      // runs it in place of the real CLI.
      const posted = await fetch(`${server.url}/launch-profiles`, {
        method: 'POST',
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          profile: {
            id: 'stopped-tabs-stub',
            name: 'Stopped tabs stream stub',
            family: 'claude',
            command: [
              process.execPath,
              path.join(REPO, 'tests/e2e/fixtures/claude-stream-stub.mjs')
            ],
            additionalArgs: []
          }
        })
      })
      t.check('the stub chat profile is on the daemon', posted.ok, posted.status)

      // The restore top-up runs after the boot mark; the rows arrive from the
      // records, stopped, with no process asked for.
      const chatRow = await until(async () => {
        const text = await rowText(win, CHAT_ID)
        return text?.includes(CHAT_TITLE) ? text : null
      })
      t.check('the stopped chat is back in the sidebar with its title', !!chatRow, chatRow)
      const termRow = await until(async () => {
        const text = await rowText(win, TERM_ID)
        return text?.includes(TERM_TITLE) ? text : null
      })
      t.check('the stopped terminal is back in the sidebar with its title', !!termRow, termRow)
      t.check(
        'no restore prompt was shown for the daemon’s records',
        (await win.getByRole('button', { name: 'Restore', exact: true }).count()) === 0
      )
      // A moment for a refusal to have taken a row out, as it used to.
      await win.waitForTimeout(1500)
      t.check(
        'both rows are still there a moment later',
        !!(await rowText(win, CHAT_ID)) && !!(await rowText(win, TERM_ID))
      )
      t.check('the chat record was not discarded', existsSync(recordFile(CHAT_ID)))
      t.check('the terminal record was not discarded', existsSync(recordFile(TERM_ID)))
      const listed = await win.evaluate(() => window.electronAPI.sessionsList())
      const chatListed = listed.find((s) => s.id === CHAT_ID)
      t.equal('the daemon lists the chat as a stopped record', chatListed?.state, 'ended')
      const processes = () => lines(path.join(ROOT, 'claude-stub-processes.jsonl'))
      t.equal('the boot started no CLI for the stopped chat', processes().length, 0)

      // Opening the stopped chat: its pane reads the end and offers Resume.
      await win.locator(`[data-sidebar-item-id="${CHAT_ID}"]`).first().click()
      const pane = win.locator(`[data-session-id="${CHAT_ID}"]`)
      await pane.locator('[data-testid="chat-view"]').waitFor({ timeout: 15_000 })
      const ended = await until(async () =>
        (await pane.locator('[data-chat-ended]').count()) > 0 ? true : null
      )
      t.check('the opened chat reads the end', ended === true)
      const resume = win.getByRole('button', { name: 'Resume', exact: true }).first()
      const offered = await until(() => resume.isVisible().catch(() => false))
      t.check('and offers Resume', offered === true)

      // Resume: the daemon relaunches the CLI on the same conversation, in
      // the mode the record kept, and the pane goes live.
      await resume.click()
      const launch = await until(() => processes()[0] ?? null, { tries: 80 })
      t.check('Resume started the CLI', !!launch, launch)
      if (launch) {
        const after = (flag) =>
          launch.argv.includes(flag) ? launch.argv[launch.argv.indexOf(flag) + 1] : null
        t.equal('on the same conversation (--resume)', after('--resume'), CHAT_CONVERSATION)
        t.equal('in the mode the record kept', after('--permission-mode'), 'acceptEdits')
        t.equal('on the model the record kept', after('--model'), 'claude-opus-5-5')
      }
      const live = await until(async () =>
        (await pane.locator('[data-chat-ended]').count()) === 0 ? true : null
      )
      t.check('the pane is live again after Resume', live === true)
      const composer = pane.locator('[data-testid="chat-view"]').getByRole('textbox', {
        name: 'Message',
        exact: true
      })
      const typing = await until(() => composer.isEnabled().catch(() => false))
      t.check('and its composer takes a message', typing === true)
    } finally {
      await app.close()
    }
  }

  // ── Part 2: the shipped default, the app's own separate server ──
  {
    const DIR = userDataDir('stopped-tabs-separate')
    const ROOT = fixturePath('stopped-tabs-separate-root')
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(ROOT, { recursive: true })
    const WS = {
      id: 'c4a70000-0000-4000-8000-000000000002',
      name: 'Stopped tabs separate',
      rootDir: ROOT,
      profileFile: null,
      createdAt: 1
    }
    seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
    seedTrustedRoots(DIR, [ROOT])
    // The separate server's own folder is where the next launch reads.
    seedSessionRecord(DIR, chatRecord(ROOT, WS.id, 'claude-chat'))
    const { app, win } = await launchApp(DIR, { server: 'separate' })
    try {
      const chatRow = await until(async () => {
        const text = await rowText(win, CHAT_ID)
        return text?.includes(CHAT_TITLE) ? text : null
      })
      t.check(
        'on the separate server the stopped chat comes back with its title',
        !!chatRow,
        chatRow
      )
      t.check(
        'and its record is still there',
        existsSync(path.join(recordsRootOf(DIR), 'session-records', `${CHAT_ID}.json`))
      )
    } finally {
      await app.close()
    }
  }

  // ── Part 3: a refused start on the in-process road keeps the tab, and Resume says why ──
  {
    const DIR = userDataDir('stopped-tabs-refused')
    const ROOT = fixturePath('stopped-tabs-refused-root')
    const CLI_LOG = path.join(ROOT, 'claude-argv.jsonl')
    rmSync(DIR, { recursive: true, force: true })
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(path.join(ROOT, 'bin'), { recursive: true })
    // The stand-in CLI: it must not run while the account has no token (the
    // spawn is refused before any process), and once the token is there it
    // logs its argv and prints a mark the window's data listener can see.
    writeFileSync(
      path.join(ROOT, 'bin', 'claude'),
      `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.includes('-p')) process.exit(0);
fs.appendFileSync(${JSON.stringify(CLI_LOG)}, JSON.stringify({ pid: process.pid, tab: process.env.CLAVE_SESSION_ID ?? null, argv }) + '\\n');
setInterval(() => process.stdout.write('stand-in claude STANDIN-MARK\\r\\n'), 400);
`,
      { mode: 0o755 }
    )
    writeFileSync(
      path.join(ROOT, 'bin', 'sh'),
      `#!/bin/sh
export PATH='${ROOT}/bin':"$PATH"
[ "$1" = '-l' ] && shift
exec /bin/sh "$@"
`,
      { mode: 0o755 }
    )
    const env = { SHELL: path.join(ROOT, 'bin', 'sh'), PATH: `${ROOT}/bin:${process.env.PATH}` }
    const WS = {
      id: 'c4a70000-0000-4000-8000-000000000003',
      name: 'Stopped tabs refused',
      rootDir: ROOT,
      profileFile: null,
      createdAt: 1
    }
    seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
    seedTrustedRoots(DIR, [ROOT])
    let app = null
    try {
      // One launch to mint the window key the record is placed by, and the
      // account the record will name: listed, with no token yet (the usage
      // read a token brings is stubbed so nothing leaves this Mac).
      const first = await launchApp(DIR, { server: 'in-process', env })
      await stubUsageFetch(first.app)
      const account = await first.win.evaluate(() =>
        window.electronAPI.claudeAccountAdd({ label: 'Later' })
      )
      await first.win.waitForTimeout(500)
      await first.app.close()
      const key = persistedWindows(DIR)[0]?.key
      t.check('the window persisted a layout key', !!key, persistedWindows(DIR))
      t.check('an account with no token is listed', typeof account?.id === 'string', account)

      // A Claude terminal on that account, its record keyed by its tmux name
      // (the shape a terminal's record takes with tmux on, round 2 N-F2):
      // the restore's start is refused, the account having no token.
      seedSessionRecord(DIR, {
        adapterId: 'pty',
        transport: 'pty',
        id: GONE_ID,
        tmuxName: GONE_TMUX,
        claudeSessionId: GONE_CONVERSATION,
        cwd: ROOT,
        folderName: path.basename(ROOT),
        displayName: GONE_TITLE,
        userRenamed: true,
        claudeMode: true,
        antigravityMode: false,
        codexMode: false,
        piMode: false,
        claudeAgentsMode: false,
        dangerousMode: false,
        claudeProfileId: account.id,
        claudeProfileLabel: 'Later',
        workspaceId: WS.id,
        windowKey: key
      })
      const recordsDir = path.join(recordsRootOf(DIR), 'session-records')
      const recordFile = path.join(recordsDir, `${GONE_TMUX}.json`)
      /** Every record file carrying the tab's id, by name. */
      const recordsOfTab = () =>
        readdirSync(recordsDir)
          .filter((f) => f.endsWith('.json'))
          .filter((f) => {
            try {
              return JSON.parse(readFileSync(path.join(recordsDir, f), 'utf8')).id === GONE_ID
            } catch {
              return false
            }
          })

      const second = await launchApp(DIR, { server: 'in-process', env, settleMs: 1500 })
      app = second.app
      const { win } = second
      await stubUsageFetch(app)
      const restore = win.getByRole('button', { name: 'Restore', exact: true })
      const prompted = await until(() => restore.isVisible().catch(() => false), { tries: 80 })
      t.check('the dead record is offered for relaunch', !!prompted)
      if (prompted) await restore.click()

      const row = await until(async () => {
        const text = await rowText(win, GONE_ID)
        return text?.includes(GONE_TITLE) ? text : null
      })
      t.check('the refused tab is in the sidebar with its title', !!row, row)
      // A moment for a refused start to have taken the row out, as it used to.
      await win.waitForTimeout(1500)
      t.check('and is still there a moment later', !!(await rowText(win, GONE_ID)))
      t.check('its record was not discarded', existsSync(recordFile), recordFile)

      // The tab's Resume re-runs the spawn, which is refused again: in words.
      if (row) await win.locator(`[data-sidebar-item-id="${GONE_ID}"]`).first().click()
      const resume = win.getByRole('button', { name: 'Resume', exact: true }).first()
      const offered = await until(() => resume.isVisible().catch(() => false))
      t.check('the opened tab offers Resume', offered === true)
      if (offered) await resume.click()
      const failure = await until(
        () =>
          win
            .evaluate(
              () => document.querySelector('[data-fleet-resume-error]')?.textContent ?? null
            )
            .catch(() => null),
        { tries: 60 }
      )
      t.check('Resume says it failed, in the tab', !!failure, failure)
      t.check(
        'with the readable reason: the account is no longer available',
        !!failure?.includes('no longer available'),
        failure
      )
      t.check('and not an unreadable id payload', !failure?.includes('{'), failure)
      t.check(
        'the tab is still in the sidebar after the failed Resume',
        !!(await rowText(win, GONE_ID))
      )
      t.check('its record is still there', existsSync(recordFile))
      t.equal('no CLI was started for it', lines(CLI_LOG).length, 0)

      // The account gets its token: Resume now succeeds, from the record
      // (round 2, N-F1 and N-F2): the same tab, the CLI on the conversation,
      // its output reaching the window that holds the tab.
      const set = await win.evaluate(
        ([id, token]) => window.electronAPI.claudeAccountSetToken(id, token),
        [account.id, LATER_TOKEN]
      )
      t.check('the token is set on the account', set !== undefined, set)
      await win.evaluate((id) => {
        window.__laneData = ''
        window.electronAPI.onSessionData(id, (d) => {
          window.__laneData += d
        })
      }, GONE_ID)
      const resumeAgain = win.getByRole('button', { name: 'Resume', exact: true }).first()
      const offeredAgain = await until(() => resumeAgain.isVisible().catch(() => false))
      t.check('Resume is offered again after the failure', offeredAgain === true)
      if (offeredAgain) await resumeAgain.click()
      const started = await until(() => lines(CLI_LOG).find((l) => l.tab === GONE_ID) ?? null, {
        tries: 60
      })
      t.check('Resume started the CLI in the same tab', !!started, lines(CLI_LOG))
      t.equal(
        'on the conversation (--resume)',
        started ? started.argv[started.argv.indexOf('--resume') + 1] : null,
        GONE_CONVERSATION
      )
      const seen = await until(
        async () =>
          (await win.evaluate(() => window.__laneData ?? '')).includes('STANDIN-MARK')
            ? true
            : null,
        { tries: 60 }
      )
      t.check('the CLI’s output reaches the window that holds the tab', seen === true)
      t.check(
        'the tab is alive',
        (await win.evaluate(() => window.electronAPI.sessionsList())).find((s) => s.id === GONE_ID)
          ?.state !== 'ended'
      )
      t.check('its row is still the one row', !!(await rowText(win, GONE_ID)))
      const files = recordsOfTab()
      t.equal('one record carries the tab', files.length, 1, files)
      t.equal(
        'and keeps the window key',
        files[0]
          ? JSON.parse(readFileSync(path.join(recordsDir, files[0]), 'utf8')).windowKey
          : null,
        key
      )
    } finally {
      if (app) await app.close()
      for (const { pid } of lines(CLI_LOG)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch (error) {
          if (error.code !== 'ESRCH') console.error('Stand-in cleanup failed', error)
        }
      }
    }
  }
}
