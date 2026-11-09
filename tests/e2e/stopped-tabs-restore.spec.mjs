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
 * Fails if: the chat or the terminal row is missing after the boot (the
 * refusal removing the tab again), a record was discarded, a restore prompt
 * is shown for the daemon's records, Resume launches no CLI or launches it
 * without `--resume`, or the separate server's restore loses the chat.
 * Nothing here reaches Anthropic: the daemon runs the Claude chat adapter on
 * the stream-json stand-in `fixtures/claude-stream-stub.mjs`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  REPO,
  launchApp,
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

const rowText = (win, id) =>
  win
    .locator(`[data-sidebar-item-id="${id}"]`)
    .first()
    .textContent()
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
}
