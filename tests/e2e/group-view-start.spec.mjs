/**
 * A group view brings its server up itself, and waits for a server that
 * takes its time.
 *
 * The board terminal every Exos project group carries (`exos board refresh;
 * exos board open --port <n>`) binds its port only after the refresh, which
 * talks to the hub and shells out to the sync worker's counts: 40 s on a
 * good day, up to two minutes behind the worker's own timeout. The pane
 * used to abandon "Starting…" after 60 s and fall back to "Server not
 * responding" with the same Start button, whose next click sent ^C into the
 * refresh still in flight — so a slow board never came up at all, and the
 * user read the whole thing as "Start does nothing". And it never started
 * anything unasked: a project group clicked open showed a dead page and a
 * button, every time, after every restart.
 *
 * Three groups from one .clave, each with a `groupView` terminal:
 *  - FAST (`auto`) binds its port at once: the pane starts it UNASKED, the
 *    frame mounts, and the terminal is linked to the group (a tmux session
 *    named for the fixture root exists).
 *  - SLOW (`auto`) sleeps 75 s before binding: the pane must still be
 *    starting past the old 60 s ceiling, counting the elapsed and offering
 *    the terminal and a Restart rather than a bare Start, and the page must
 *    appear on its own once the server answers.
 *  - MANUAL (`prefill`) is the control: nothing starts unasked, the Start
 *    button is offered, and no session is spawned for it.
 * Put a clock back on the starting state in WebViewPane.tsx and SLOW goes
 * red; drop the auto start and FAST does; auto-start prefill terminals and
 * MANUAL does.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  killLeakedE2eTmux,
  fixturePath,
  freePorts
} from './harness.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const DIR = userDataDir('group-view-start')
const ROOT = fixturePath('group-view-start-root')
const CLAVE = `${ROOT}/boards.clave`
const WS = {
  id: 'dddddddd-0000-4000-8000-00000000000d',
  name: 'Boards',
  rootDir: ROOT,
  profileFile: CLAVE,
  createdAt: 1
}
// Asked of the OS, not fixed: a second run at once would otherwise find its
// board already served by the first run's server.
const [FAST_PORT, SLOW_PORT, MANUAL_PORT] = await freePorts(3)
const SLOW_DELAY_S = 75
// tmux names carry the cwd's basename cut to 24 characters.
const FIXTURE_TMUX_MARK = 'clave-e2e-group-view'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** What the visible view pane shows: the frame, the notice, its buttons. */
function paneState(win) {
  return win.evaluate(() => {
    const visible = (el) => el && !el.closest('[aria-hidden="true"]')
    const title = [...document.querySelectorAll('[data-testid="view-title"]')].find(visible)
    if (!title) return { pane: false }
    const card = title.closest('.floating-card')
    const notice = card.querySelector('[data-testid="view-notice-text"]')?.textContent ?? ''
    const elapsed = card.querySelector('[data-testid="view-notice-elapsed"]')?.textContent ?? null
    const frame = [...card.querySelectorAll('webview')].some(
      (w) => w.getBoundingClientRect().width > 0
    )
    const buttons = [...card.querySelectorAll('[data-testid="view-notice"] button')].map((b) =>
      b.textContent.trim()
    )
    return {
      pane: true,
      title: title.textContent,
      frame,
      notice,
      elapsed,
      starting: /starting/i.test(notice),
      down: /not responding/.test(notice),
      buttons,
      error: card.querySelector('[data-testid="view-start-error"]')?.textContent ?? null
    }
  })
}

async function untilFrame(win, ms) {
  const deadline = Date.now() + ms
  let last = null
  while (Date.now() < deadline) {
    last = await paneState(win)
    if (last.frame) return last
    await sleep(500)
  }
  return last
}

function fixtureTmuxSessions() {
  try {
    return execFileSync('tmux', ['-L', 'clave', 'list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf-8'
    })
      .split('\n')
      .filter((n) => n.includes(FIXTURE_TMUX_MARK))
  } catch {
    return []
  }
}

/** Open a pinned group from the picker and land on its view pane. */
async function openGroup(win, name) {
  await win.click('button[aria-label="Add a group"]')
  await win.waitForTimeout(700)
  await win.locator('.group-picker-card', { hasText: name }).first().click()
  await win.waitForTimeout(2500)
  let state = await paneState(win)
  if (!state.pane || state.title !== name) {
    await win.locator('[data-sidebar-item-type="group"]', { hasText: name }).first().click()
    await win.waitForTimeout(1500)
    state = await paneState(win)
  }
  return state
}

const boardTerminal = (port, command, commandMode = 'auto') => ({
  command,
  commandMode,
  color: 'purple',
  icon: 'bolt',
  serverUrl: `http://127.0.0.1:${port}`,
  groupView: true
})

const seed = (name) => ({
  cwd: '.',
  name,
  claudeMode: false,
  antigravityMode: false,
  codexMode: false,
  dangerousMode: false
})

export async function run(t) {
  killLeakedE2eTmux()
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(
    CLAVE,
    JSON.stringify(
      {
        $schema: 'clave/1.0',
        groups: [
          {
            name: 'Fast board',
            cwd: '.',
            color: 'blue',
            sessions: [seed('fast-seed')],
            terminals: [boardTerminal(FAST_PORT, `python3 -m http.server ${FAST_PORT} --bind 127.0.0.1`)]
          },
          {
            name: 'Slow board',
            cwd: '.',
            color: 'teal',
            sessions: [seed('slow-seed')],
            terminals: [
              boardTerminal(SLOW_PORT, `sleep ${SLOW_DELAY_S}; python3 -m http.server ${SLOW_PORT} --bind 127.0.0.1`)
            ]
          },
          {
            name: 'Manual board',
            cwd: '.',
            color: 'green',
            sessions: [seed('manual-seed')],
            terminals: [
              boardTerminal(MANUAL_PORT, `python3 -m http.server ${MANUAL_PORT} --bind 127.0.0.1`, 'prefill')
            ]
          }
        ]
      },
      null,
      2
    )
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR)
  try {
    // ── MANUAL first: the control, before any auto start could confuse it ──
    let state = await openGroup(win, 'Manual board')
    t.check('MANUAL: the group opens on its view pane', state.pane && state.title === 'Manual board', state)
    await sleep(4000)
    state = await paneState(win)
    t.check(
      'MANUAL: a prefill terminal is not started unasked — the pane reports the server down with a Start button',
      state.down && !state.frame && state.buttons.includes('Start'),
      state
    )
    let listed = await callMcp(app, 'list', {})
    const manual = listed.groups.find((g) => g.name === 'Manual board')
    t.check('MANUAL: no session was spawned for it', manual?.terminals?.[0]?.sessionId == null, manual)

    // ── FAST: an auto terminal starts itself and the page mounts ──────────
    state = await openGroup(win, 'Fast board')
    t.check('FAST: the group opens on its view pane', state.pane && state.title === 'Fast board', state)
    const fastUp = await untilFrame(win, 20_000)
    t.check('FAST: the page frame mounts within 20 s with no click at all', fastUp?.frame === true, fastUp)

    listed = await callMcp(app, 'list', {})
    const fastGroup = listed.groups.find((g) => g.name === 'Fast board')
    t.check(
      'FAST: the group terminal is linked to the session the auto start spawned',
      typeof fastGroup?.terminals?.[0]?.sessionId === 'string',
      fastGroup
    )
    const sessions = fixtureTmuxSessions()
    t.check('FAST: the serving shell is a tmux session named for the fixture', sessions.length >= 1, sessions)

    // ── SLOW: a server that binds after the old 60 s ceiling ──────────────
    state = await openGroup(win, 'Slow board')
    t.check('SLOW: the group opens on its own view pane', state.pane && state.title === 'Slow board', state)
    const t0 = Date.now()

    // Sample the pane every 5 s until the frame shows or 100 s pass. The
    // timeline is the evidence: it says when (and whether) the pane gave up.
    const timeline = []
    let slowUp = null
    while (Date.now() - t0 < 100_000) {
      const s = await paneState(win)
      timeline.push({ t: Math.round((Date.now() - t0) / 1000), notice: s.notice, elapsed: s.elapsed, frame: s.frame, buttons: s.buttons })
      if (s.frame) {
        slowUp = s
        break
      }
      await sleep(5000)
    }
    const early = timeline.find((s) => s.t >= 5 && s.t <= 20)
    t.check(
      'SLOW: the pane started the terminal unasked and counts the seconds',
      early
        ? early.notice === 'Starting the server…' &&
            /^\d+:\d\d$/.test(early.elapsed ?? '') &&
            early.buttons.length === 0
        : false,
      timeline
    )
    const at65 = timeline.find((s) => s.t >= 63 && s.t <= 72)
    t.check(
      `SLOW: at ~65 s (past the old ceiling, before the ${SLOW_DELAY_S} s bind) the pane is still starting — "Still starting" with the clock, the terminal and a Restart offered, never "not responding"`,
      at65
        ? /^Still starting/.test(at65.notice) &&
            /^1:\d\d$/.test(at65.elapsed ?? '') &&
            at65.buttons.includes('Restart') &&
            at65.buttons.includes('Show terminal') &&
            !at65.buttons.includes('Retry')
        : false,
      timeline
    )
    t.check(
      'SLOW: the page frame appears on its own once the server binds (no click)',
      slowUp?.frame === true,
      timeline
    )
  } finally {
    await app.close()
    killLeakedE2eTmux()
  }
}
