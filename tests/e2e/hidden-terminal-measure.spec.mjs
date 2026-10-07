// Pinned to the in-process server (wave 2 of the server/client split,
// PRDCT-3239): this spec starts a session through the app, and a standalone
// server refuses every start until its terminal process exists (wave 3);
// the shared attached-mode fixture seam comes with it. Not a known failure.
/**
 * A terminal nobody is looking at repaints without re-measuring its glyphs.
 *
 * The bug (profiled on the packaged app, 2026-09-28): with a few agents
 * starting, the whole window froze for over a minute. 98% of the frozen time
 * was one xterm function, the DOM renderer's glyph-width measure. That measure
 * sets a span's text and reads `offsetWidth`, forcing a layout of the whole
 * window, and its cache only keeps widths above zero. Unselected terminal tiles
 * were hidden with `display: none`, and the whole grid was too while Settings
 * or a plugin panel was open, so every glyph measured 0 and nothing was ever
 * cached. Each repaint of a hidden terminal then forced one full layout PER
 * GLYPH, and a hidden terminal repaints all its rows whenever its selection is
 * cleared, which is what an agent starting does to it.
 *
 * The cache is per glyph, so a terminal only pays for glyphs it never drew at
 * a real width: output that arrives while it is hidden, or a restored tab that
 * has not been opened since launch. The spec therefore writes fresh glyphs to
 * each terminal only while it is hidden.
 *
 * What this spec asserts is the cost itself, not the CSS that avoids it: how
 * many times a hidden terminal's measure elements are read during a repaint
 * driven through xterm's own selection path. On the broken code that number is
 * one read per glyph on EVERY repaint; fixed, the widths are cached after the
 * first and a repeat repaint reads nothing. Two controls keep a zero from
 * passing for the wrong reason: the read counter is shown to count, and the
 * repaint is shown to really rewrite the rows (a trigger wired to nothing would
 * also read nothing).
 *
 * Both hiding places are covered: an unselected tile in the mosaic, and the
 * selected tile while Settings covers the mosaic.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  fixturePath,
  until
} from './harness.mjs'
import { mkdirSync } from 'node:fs'

const DIR = userDataDir('hidden-terminal-measure')
const ROOT = fixturePath('hidden-terminal-measure-root')
const WS = {
  id: 'eeeeeeee-0000-4000-8000-0000000000b7',
  name: 'Hidden terminals',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const GLYPHS = 'echo HIDDEN-TERMINAL-GLYPHS-abcdefghijklmnopqrstuvwxyz-0123456789'
// Glyphs neither screen has shown yet, one set per phase. The cache that
// matters is filled per glyph, so what a hidden terminal pays for is output it
// receives while hidden (or a restored tab never opened since launch): glyphs
// it has never drawn at a real width.
const FRESH_WHILE_HIDDEN = "echo 'QQ VV WW XX ZZ KK'"
const FRESH_BEHIND_SETTINGS = "echo '{} [] <> ~^ |'"

function write(win, sessionId, text) {
  return win.evaluate(({ s, t }) => window.electronAPI.writeSession(s, `${t}\r`), {
    s: sessionId,
    t: text
  })
}

/** Count every `offsetWidth` read on an xterm glyph-measure element, per tile. */
function installReadCounter(win) {
  return win.evaluate(() => {
    const native = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    window.__measureReads = {}
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        if (this.classList?.contains('xterm-char-measure-element')) {
          const tile =
            this.closest('[data-terminal-tile]')?.getAttribute('data-terminal-tile') ?? '?'
          window.__measureReads[tile] = (window.__measureReads[tile] ?? 0) + 1
        }
        return native.get.call(this)
      }
    })
    return true
  })
}

/** Cycle a terminal's selection and report, for that one repaint, how many
 *  glyph measures it read and how many row mutations it made. */
function repaint(win, sessionId) {
  return win.evaluate(async (id) => {
    const rows = document.querySelector(`[data-terminal-tile="${id}"] .xterm-rows`)
    if (!rows) return { ok: false, reason: 'no rows element' }
    let mutations = 0
    const observer = new MutationObserver((list) => (mutations += list.length))
    observer.observe(rows, { childList: true, subtree: true })
    const before = window.__measureReads[id] ?? 0
    const ok = window.__claveCycleTerminalSelection?.(id) ?? false
    // xterm repaints the selection on the next animation frame; give it two.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    await new Promise((r) => setTimeout(r, 50))
    observer.disconnect()
    return { ok, reads: (window.__measureReads[id] ?? 0) - before, mutations }
  }, sessionId)
}

function tileState(win, sessionId) {
  return win.evaluate((id) => {
    const tile = document.querySelector(`[data-terminal-tile="${id}"]`)
    if (!tile) return null
    const r = tile.getBoundingClientRect()
    return {
      visibility: getComputedStyle(tile).visibility,
      inert: tile.inert,
      width: Math.round(r.width),
      height: Math.round(r.height)
    }
  }, sessionId)
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR, { server: 'in-process' })
  try {
    const hidden = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'terminal',
      name: 'hidden-tab'
    })
    const shown = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'terminal',
      name: 'shown-tab'
    })
    t.check('two terminal tabs open', !!hidden?.sessionId && !!shown?.sessionId, { hidden, shown })

    // Put glyphs on both screens while each is on screen, then leave the
    // hidden one behind the shown one.
    for (const id of [hidden.sessionId, shown.sessionId]) {
      await callMcp(app, 'focus', { sessionId: id })
      await until(() =>
        win.evaluate((s) => !!document.querySelector(`[data-terminal-tile="${s}"] .xterm-rows`), id)
      )
      await win.waitForTimeout(1500)
      await write(win, id, GLYPHS)
      await win.waitForTimeout(800)
    }
    await callMcp(app, 'focus', { sessionId: shown.sessionId })
    await win.waitForTimeout(800)
    await write(win, hidden.sessionId, FRESH_WHILE_HIDDEN)
    await win.waitForTimeout(1000)

    const hiddenTile = await tileState(win, hidden.sessionId)
    const shownTile = await tileState(win, shown.sessionId)
    t.equal('the unselected tile is not visible', hiddenTile?.visibility, 'hidden')
    t.equal('and is inert, so no keystroke or click reaches it', hiddenTile?.inert, true)
    t.equal('the selected tile is visible', shownTile?.visibility, 'visible')

    await installReadCounter(win)
    // CONTROL: the counter counts. One direct read must show up as one read.
    const direct = await win.evaluate((id) => {
      const el = document.querySelector(`[data-terminal-tile="${id}"] .xterm-char-measure-element`)
      if (!el) return null
      const before = window.__measureReads[id] ?? 0
      void el.offsetWidth
      return (window.__measureReads[id] ?? 0) - before
    }, hidden.sessionId)
    t.equal('control: the read counter sees a glyph measure', direct, 1)

    // ── 1. An unselected tile ──
    const warm = await repaint(win, hidden.sessionId)
    t.check(
      'control: the selection cycle repaints the hidden terminal',
      warm.ok && warm.mutations > 0,
      warm
    )
    t.check(
      'control: that repaint meets glyphs the terminal had never measured',
      warm.reads > 0,
      warm
    )
    const again = await repaint(win, hidden.sessionId)
    t.check('control: a second cycle repaints it again', again.ok && again.mutations > 0, again)
    t.check(
      'a repeat repaint of a hidden terminal measures no glyph (widths were cached)',
      again.reads === 0,
      { firstRepaintReads: warm.reads, repeatRepaintReads: again.reads }
    )

    // ── 2. The selected tile, while Settings covers the mosaic ──
    await win.click('.sidebar-footer-btn[aria-label="Settings"]')
    await win.waitForTimeout(800)
    const behindSettings = await tileState(win, shown.sessionId)
    t.equal('behind Settings the terminal is not visible', behindSettings?.visibility, 'hidden')
    t.check(
      'and keeps its size, so leaving Settings resizes no terminal',
      behindSettings?.width === shownTile?.width && behindSettings?.height === shownTile?.height,
      { before: shownTile, behindSettings }
    )
    await write(win, shown.sessionId, FRESH_BEHIND_SETTINGS)
    await win.waitForTimeout(1000)
    // Covered rather than collapsed, this terminal is still laid out, so it
    // drew the fresh glyphs at a real width as they arrived and a repaint finds
    // them cached. Collapsed (the old code), the same repaint read 20 of them.
    await repaint(win, shown.sessionId)
    const settingsAgain = await repaint(win, shown.sessionId)
    t.check(
      'control: the terminal behind Settings repaints',
      settingsAgain.ok && settingsAgain.mutations > 0,
      settingsAgain
    )
    t.check(
      'a repeat repaint behind Settings measures no glyph',
      settingsAgain.reads === 0,
      settingsAgain
    )
  } finally {
    await app.close()
  }
}
