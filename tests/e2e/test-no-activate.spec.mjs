/**
 * `--test-no-activate`: the app under automated test must not steal the focus
 * — nor the screen.
 *
 * An E2E run launches a second Electron instance on the same desktop a human is
 * working on. Without this flag every `ready-to-show` yanked the keyboard away
 * mid-sentence and dropped a second Clave icon in the Dock; with the first
 * version of the flag (`showInactive()`) the keyboard stayed put but every new
 * window still landed at the FRONT of the desktop, over the human's work. The
 * flag now makes the instance a macOS accessory whose windows are never shown
 * at all, with background throttling off so the hidden renderer keeps running.
 * `harness.mjs` passes it on every launch, so this spec asserts the harness's
 * own default rather than a special launch of its own.
 *
 * The load-bearing claims: no window is ever on screen, none is ever key, and
 * the driver can still work the app end to end (Playwright drives the renderer
 * over the debugger protocol; a hidden page with throttling off answers).
 * The `show` event is recorded on a second window opened AFTER the recorder is
 * installed: it must never fire.
 */
import {
  launchApp,
  seedWorkspaces,
  userDataDir,
  openWindow,
  windows as allWindows,
  until,
  fixturePath
} from './harness.mjs'
import { mkdirSync } from 'node:fs'

const DIR = userDataDir('no-activate')
const ROOT_A = fixturePath('no-activate-a')
const ROOT_B = fixturePath('no-activate-b')
const WS_A = {
  id: 'cccccccc-0000-4000-8000-00000000000c',
  name: 'NoActivateA',
  rootDir: ROOT_A,
  profileFile: null,
  createdAt: 1
}
const WS_B = {
  id: 'dddddddd-0000-4000-8000-00000000000d',
  name: 'NoActivateB',
  rootDir: ROOT_B,
  profileFile: null,
  createdAt: 2
}

export async function run(t) {
  mkdirSync(ROOT_A, { recursive: true })
  mkdirSync(ROOT_B, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS_A, WS_B], activeWorkspaceId: WS_A.id, fresh: true })

  // settleMs: 0 — read the first window's state as early as the harness allows,
  // before the desktop has had seconds to hand this instance activation.
  const { app, win } = await launchApp(DIR, { settleMs: 0 })
  try {
    // ── it boots at all under the flag ──
    const argv = await app.evaluate(() => process.argv)
    t.check(
      'the main process received --test-no-activate',
      argv.includes('--test-no-activate'),
      argv
    )

    const first = await app.evaluate(({ app, BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      return {
        windows: BrowserWindow.getAllWindows().length,
        visible: w ? w.isVisible() : null,
        focused: w ? w.isFocused() : null,
        dockVisible: process.platform === 'darwin' ? (app.dock?.isVisible() ?? null) : null
      }
    })
    t.equal('exactly one window opened', first.windows, 1)
    t.equal('the window is NOT on screen', first.visible, false)
    t.equal('and it is not key', first.focused, false)
    t.equal('no Dock icon: the instance runs as an accessory', first.dockVisible, false)

    // ── the race-free measurement: a window opened after the recorder is
    //    installed must never reach a show event, yet must boot and answer ──
    await app.evaluate(({ app }) => {
      globalThis.__showStates = []
      globalThis.__readyStates = []
      app.on('browser-window-created', (_e, w) => {
        w.once('ready-to-show', () => globalThis.__readyStates.push({ id: w.id }))
        w.once('show', () =>
          globalThis.__showStates.push({ id: w.id, visible: w.isVisible(), focused: w.isFocused() })
        )
      })
    })
    const opened = await openWindow(app, win, WS_B.id, { settleMs: 1500 })
    t.check('opening workspace B made a NEW window', typeof opened.windowId === 'number', opened)
    // Bounded wait: under host load a new window can take longer than any
    // fixed delay to reach ready-to-show (ceiling 30s, the contention-ledger
    // convention). What is asserted is that it got there — and no further.
    const ready =
      (await until(
        async () => {
          const r = await app.evaluate(() => globalThis.__readyStates)
          return r.length >= 1 ? r : null
        },
        { tries: 120, gapMs: 250 }
      )) ?? (await app.evaluate(() => globalThis.__readyStates))
    t.check('the new window reached ready-to-show (it booted)', ready.length === 1, ready)
    const shown = await app.evaluate(() => globalThis.__showStates)
    t.check('and was never shown: no show event at all', shown.length === 0, shown)
    const second = await app.evaluate(({ BrowserWindow }, id) => {
      const w = BrowserWindow.fromId(id)
      return w ? { visible: w.isVisible(), focused: w.isFocused() } : null
    }, opened.windowId)
    t.equal('the second window is not on screen', second?.visible, false)
    t.equal('nor key', second?.focused, false)
    t.equal('both windows are open', (await allWindows(app)).length, 2)
    const answered = await opened.page.evaluate(() => window.electronAPI.windowIdentity())
    t.equal('and the hidden second window answers over the driver', answered?.windowId, opened.windowId)

    // ── the driver can still work the app without OS focus ──
    // Focus is an OS concept; Playwright drives the renderer over CDP and does
    // not need it. If that were false the whole suite would be unrunnable under
    // the flag, so prove one real interaction end to end.
    await win.click('.launcher-caret')
    await win.waitForTimeout(800)
    const menuItems = await win.evaluate(
      () => document.querySelectorAll('[role="menuitem"]').length
    )
    t.check('clicking the launcher caret opens the agent menu', menuItems > 0, menuItems)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
    t.check(
      'and Escape closes it — keyboard input lands too',
      await win.evaluate(() => document.querySelectorAll('[role="menuitem"]').length === 0)
    )
  } finally {
    await app.close()
  }
}
