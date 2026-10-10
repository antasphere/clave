// Runs in BOTH modes (wave 4, lane C, PRDCT-3376): the restore now reads the
// records from whichever process keeps them — the app in-process, the
// standalone server attached — and brings the window's tabs back either way.
// The records live where the terminal manager of the launch runs, which is
// why `recordsRoot` follows `server?.dataDir` below. The session is created
// through the app, so no record is seeded by hand.
/**
 * A terminal started, written to, and reattached after a restart (PRDCT-3240).
 *
 * The terminal backend now keeps its records through the storage port and
 * gets its process through the terminal port. Both are silent if wrong: a
 * record written to the wrong folder, or a tmux client that is not the one
 * the port spawned, shows as a tab that does not come back after a quit, with
 * nothing in any log. This spec runs the whole life of one terminal on the
 * REAL app and the REAL tmux server:
 *
 *   1. a plain terminal launched from the launcher is tmux-backed, and its
 *      record sits in `<userData>/session-records/<tmux name>.json`;
 *   2. a line written through the app reaches the process (tmux's own pane
 *      says so), and the terminal journal saw the same bytes;
 *   3. quitting the app detaches: the tmux session and the record survive;
 *   4. the next launch brings the SAME tab back (same id) on the live
 *      process, with the earlier output repainted into its terminal;
 *   5. a line written after the reattach reaches the same process;
 *   6. closing the tab for good kills the tmux session and drops the record.
 *
 * Mutate `writeSessionRecord` to write elsewhere, or `kill(id, false)` to
 * destroy the tmux session on quit, and step 4 goes red; mutate the terminal
 * port's `write` to drop bytes and step 2 goes red.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  userDataDir,
  fixturePath,
  until,
  callMcp,
  tmuxSessionAlive,
  writeJournal
} from './harness.mjs'

const DIR = userDataDir('terminal-reattach')
const ROOT = fixturePath('root-terminal-reattach')
const WS = {
  id: 'aaaaaaaa-0000-4000-8000-00000000003f',
  name: 'Reattach',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const MARKER_1 = `REATTACH-FIRST-${process.pid}`
const MARKER_2 = `REATTACH-SECOND-${process.pid}`

const liveIds = (win) =>
  win.evaluate(() => window.electronAPI.sessionsList().then((all) => all.map((s) => s.id)))

/** The session records live where the terminal manager runs: under the
 *  app's data folder in-process, under the server's when attached. */
let recordsRoot = DIR
function recordOf(id) {
  const dir = path.join(recordsRoot, 'session-records')
  if (!existsSync(dir)) return null
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const r = JSON.parse(readFileSync(path.join(dir, f), 'utf-8'))
    if (r.id === id) return { ...r, file: path.join(dir, f) }
  }
  return null
}

/** What the session's pane shows, from tmux itself. A bare session name can
 *  fail to resolve as a PANE target on tmux 3.7c (see multi-window-move), so
 *  the pane id is looked up first and the capture asks for it. */
function paneText(tmuxName) {
  try {
    const paneId = execFileSync(
      'tmux',
      ['-L', 'clave', 'list-panes', '-t', `=${tmuxName}`, '-F', '#{pane_id}'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
      .trim()
      .split('\n')[0]
    if (!paneId) return ''
    return execFileSync('tmux', ['-L', 'clave', 'capture-pane', '-p', '-t', paneId], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return ''
  }
}

const tileText = (win, id) =>
  win.evaluate(
    (s) => document.querySelector(`[data-terminal-tile="${s}"] .xterm-rows`)?.textContent ?? '',
    id
  )

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })

  let tmuxName = null
  const first = await launchApp(DIR)
  recordsRoot = first.server?.dataDir ?? DIR
  let id
  try {
    const { win } = first
    const before = new Set(await liveIds(win))
    const writesTo = writeJournal(DIR)
    await win.click('.launcher-row button')
    id = await until(async () => (await liveIds(win)).find((s) => !before.has(s)) ?? null)
    t.check('a plain terminal launches from the launcher', !!id)
    if (!id) return
    const record = await until(() => recordOf(id))
    t.check('its record is written under session-records', !!record, record)
    tmuxName = record?.tmuxName ?? null
    t.check(
      'as a tmux-backed session named for its folder',
      typeof tmuxName === 'string' && /^clave-/.test(tmuxName),
      tmuxName
    )
    t.check(
      'keyed by the tmux name',
      record?.file === path.join(recordsRoot, 'session-records', `${tmuxName}.json`),
      record?.file
    )
    t.check('the tmux session is alive', tmuxName && tmuxSessionAlive(tmuxName))

    // The terminal must have started (the pane mounted and reported its
    // size) before a write means anything.
    await until(() => (tmuxName ? paneText(tmuxName).trim().length > 0 : false))
    await win.evaluate(
      ([s, line]) => window.electronAPI.writeSession(s, line),
      [id, `echo ${MARKER_1}\r`]
    )
    const seen = await until(() => paneText(tmuxName).includes(MARKER_1), { tries: 60 })
    t.check('a line written through the app reaches the process', !!seen, {
      pane: paneText(tmuxName),
      tile: (await tileText(win, id)).slice(-200),
      mounted: await win.evaluate(
        (s) => !!document.querySelector(`[data-terminal-tile="${s}"] .xterm`),
        id
      )
    })
    const journaled = await writesTo(id)
    t.check('and the terminal journal saw the same bytes', journaled.includes(`echo ${MARKER_1}\r`))
    const echoed = await until(() => paneText(tmuxName).split(MARKER_1).length > 2, { tries: 40 })
    t.check('the shell ran it (the marker is printed back, not only typed)', !!echoed)
  } finally {
    await first.app.close()
  }

  t.check('after the quit the tmux session survives', !!tmuxName && tmuxSessionAlive(tmuxName))
  t.check('and so does the record', !!id && !!recordOf(id))

  const second = await launchApp(DIR, { settleMs: 6000 })
  try {
    const { app, win } = second
    const back = await until(async () => ((await liveIds(win)).includes(id) ? id : null))
    t.check('the next launch brings the same tab back, same id', back === id, {
      wanted: id,
      live: await liveIds(win)
    })
    const repainted = await until(async () => (await tileText(win, id)).includes(MARKER_1), {
      tries: 60
    })
    t.check(
      "the earlier output is repainted into the tab's terminal",
      !!repainted,
      (await tileText(win, id)).slice(-300)
    )
    t.check('on the live tmux session, not a new one', recordOf(id)?.tmuxName === tmuxName)
    await win.evaluate(
      ([s, line]) => window.electronAPI.writeSession(s, line),
      [id, `echo ${MARKER_2}\r`]
    )
    const again = await until(() => paneText(tmuxName).includes(MARKER_2), { tries: 60 })
    t.check('a line written after the reattach reaches the same process', !!again)

    await callMcp(app, 'closeSession', { sessionId: id })
    const dead = await until(() => !tmuxSessionAlive(tmuxName), { tries: 60 })
    t.check('closing the tab for good kills the tmux session', !!dead)
    const dropped = await until(() => !recordOf(id))
    t.check('and drops the record', !!dropped)
  } finally {
    await second.app.close()
  }
}
