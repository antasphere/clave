// Pinned to the in-process server: the walk opens tabs through the agent
// tools' road (`callMcp`, the dispatcher main's MCP server drives) and reads
// what is typed into a terminal off the terminal journal, which this mode
// writes in the app's own data folder.
/**
 * Back and Forward walk the places the content area showed (PRDCT-5155), in
 * the real app.
 *
 * A place is what the content column shows plus the workspace: one tab or a
 * mosaic of several, Settings on a page, a group's or a tab's own page, a
 * plugin's page. The window records each one once it has settled for 300 ms,
 * whoever moved there, and the toolbar's Back and Forward, ⌘[ and ⌘], the
 * mouse's side buttons and the list behind a right-click on either button
 * step through them. Every step below is asserted twice: on what the person
 * sees (the selected sidebar row, the tiles on screen, the page's title, the
 * buttons' `disabled`) and on the recorded order, read off the test seam
 * `window.__claveNavigationForTests.snapshot()`.
 *
 * The walk: three tabs stepped through by a row click, ⌘⇧], the buttons and
 * the keys; a mosaic whose focus moves without a new place; Settings on two
 * pages; a group's page and a tab's page, each left by Back for the mosaic
 * under it; the Analytics page; a tab an agent opens; a closed tab skipped;
 * a second workspace switched back to; the list behind the button, nearest
 * first; the mouse's side buttons; and the code editor, which keeps ⌘[ and
 * ⌘] for its own outdent and indent. The cards beside a tab (an artefact, a
 * document) are walked in navigation-history-beside.spec.mjs.
 *
 * Where the keyboard focus lands after a move is checked by typing: what is
 * typed after Back must reach the restored tab's terminal (the terminal
 * journal says which tab received it), as it does after a click on the tab's
 * own sidebar row.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  callMcp,
  until,
  writeJournal
} from './harness.mjs'

const DIR = userDataDir('navigation-history')
const ROOT = fixturePath('navigation-history-root')
const ELSEWHERE_ROOT = fixturePath('navigation-history-elsewhere')
const WS = {
  id: 'aaaaaaaa-0000-4000-8000-000000005155',
  name: 'Navigation',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const ELSEWHERE = {
  id: 'bbbbbbbb-0000-4000-8000-000000005155',
  name: 'Elsewhere',
  rootDir: ELSEWHERE_ROOT,
  profileFile: null,
  createdAt: 2
}
const BOARD = `${ROOT}/board.html`
const DASH = `${ROOT}/dash.html`
const CODE = `${ROOT}/notes.ts`
const ANALYTICS = 'clave.analytics'
/** Longer than the 300 ms a place takes to settle, with room for a busy machine: the wait
 *  before a check that NOTHING was recorded. A check that something was recorded waits for
 *  the snapshot to change instead. */
const QUIET_MS = 1200

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rowOf = (id) => `[data-sidebar-item-id="${id}"] button.sidebar-item`
const BACK = '[data-nav="back"]'
const FORWARD = '[data-nav="forward"]'

/** The recorded history: `{ index, places }`, or null when the seam is missing. */
const snapshot = (win) => win.evaluate(() => window.__claveNavigationForTests?.snapshot() ?? null)

/** Poll the snapshot until `pred` holds; answers the last one read either way, so a check
 *  on it fails with the actual history rather than a timeout. */
async function snapshotUntil(win, pred, ms = 6000) {
  const started = Date.now()
  let s = await snapshot(win)
  while (!(s && pred(s)) && Date.now() - started < ms) {
    await sleep(100)
    s = await snapshot(win)
  }
  return s
}

const current = (s) => (s && s.index >= 0 ? s.places[s.index] : null)
/** The places as short strings (the current one marked `>`), for a readable failure. */
const trail = (s) =>
  s
    ? s.places.map(
        (p, i) =>
          `${i === s.index ? '>' : ''}${p.label} [${p.kind}] ${p.view}:${p.tabs.join('+') || '-'}${p.groupView ? ':group' : ''}${p.tabView ? ':tabpage' : ''}${p.plugin ? `:${p.plugin}` : ''}`
      )
    : null

/** What the person sees: the selected session rows, the terminal tiles on screen, the
 *  title of the page over the column, a plugin's page, Settings' selected page, and the
 *  workspace the switcher names. */
function screen(win) {
  return win.evaluate(() => {
    const shown = (el) =>
      el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
      el.getBoundingClientRect().width > 0
    return {
      tiles: [...document.querySelectorAll('[data-terminal-tile]')]
        .filter((el) => el.getAttribute('aria-hidden') !== 'true' && shown(el))
        .map((el) => el.getAttribute('data-terminal-tile')),
      rows: [...document.querySelectorAll('[data-sidebar-item-type="session"]')]
        .filter((row) => row.querySelector(':scope > button[data-selected="true"]'))
        .map((row) => row.getAttribute('data-sidebar-item-id')),
      title:
        [...document.querySelectorAll('[data-testid="view-title"]')].find(shown)?.textContent ??
        null,
      plugin:
        [...document.querySelectorAll('[data-plugin-page]')]
          .find(shown)
          ?.getAttribute('data-plugin-page') ?? null,
      settings:
        document
          .querySelector('[data-settings-nav-row][data-selected="true"]')
          ?.getAttribute('data-settings-nav-row') ?? null,
      workspace:
        document.querySelector('button[aria-label="Switch workspace"]')?.textContent?.trim() ?? null
    }
  })
}

/** Poll the screen until `pred` holds; answers the last reading. */
async function screenUntil(win, pred, ms = 6000) {
  const started = Date.now()
  let s = await screen(win)
  while (!pred(s) && Date.now() - started < ms) {
    await sleep(100)
    s = await screen(win)
  }
  return s
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sorted = (a) => [...a].sort()

/** Where the keyboard focus is: in a terminal tile (which one), on a toolbar button, on a
 *  sidebar row, or elsewhere. */
function focusOf(win) {
  return win.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return { where: 'body' }
    const tile = el.closest('[data-terminal-tile]')?.getAttribute('data-terminal-tile') ?? null
    return {
      where: tile
        ? 'terminal'
        : el.closest('[data-nav]')
          ? `button:${el.closest('[data-nav]').getAttribute('data-nav')}`
          : el.closest('[data-sidebar-item-id]')
            ? 'sidebar-row'
            : el.tagName.toLowerCase(),
      tile
    }
  })
}

/** Type `marker` (letters only: no key that would press a focused button) and answer the
 *  tab whose terminal received it, or null when it reached none of `ids`. */
async function typedInto(win, writesTo, ids, marker) {
  await win.keyboard.type(marker)
  return until(
    async () => {
      for (const id of ids) if ((await writesTo(id)).includes(marker)) return id
      return null
    },
    { tries: 20, gapMs: 150 }
  )
}

async function openTerminal(app, name, cwd = ROOT) {
  const opened = await callMcp(app, 'openSession', { mode: 'terminal', cwd, name })
  if (typeof opened?.sessionId !== 'string') throw new Error(`no tab opened for ${name}`)
  return opened.sessionId
}

/** Switch the window to a workspace through the toolbar's switcher, as a person does. */
async function switchWorkspace(win, workspace) {
  const item = win.locator(`[data-workspace-id="${workspace.id}"]`)
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!(await item.count())) {
      await win.locator('button[aria-label="Switch workspace"]').click()
      await item.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {})
    }
    await item.click({ timeout: 2000 }).catch(() => {})
    const now = await screenUntil(win, (s) => s.workspace === workspace.name, 2000)
    if (now.workspace === workspace.name) {
      if (await item.count()) await win.keyboard.press('Escape')
      return true
    }
  }
  return false
}

/** Whether a toolbar button is disabled, as the DOM says. */
const disabled = (win, selector) => win.locator(selector).isDisabled()

/** Press a mouse side button over an element through the browser's own input pipeline
 *  (the event reaches the page as a real `mousedown`/`mouseup` with button 3 or 4). */
async function sideButton(app, win, button, selector) {
  const box = await win.locator(selector).first().boundingBox()
  if (!box) throw new Error(`nothing to press ${button} over: ${selector}`)
  const at = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
  const cdp = await app.context().newCDPSession(win)
  try {
    const buttons = button === 'back' ? 8 : 16
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...at,
      button,
      buttons,
      clickCount: 1
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...at,
      button,
      buttons: 0,
      clickCount: 1
    })
  } finally {
    await cdp.detach()
  }
}

export async function run(t) {
  for (const root of [ROOT, ELSEWHERE_ROOT]) {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
  }
  writeFileSync(BOARD, '<!doctype html><title>Board</title><h1>Board</h1>')
  writeFileSync(DASH, '<!doctype html><title>Dash</title><h1>Dash</h1>')
  writeFileSync(CODE, 'function answer() {\n    return 42\n}\n')
  seedWorkspaces(DIR, {
    workspaces: [WS, ELSEWHERE],
    activeWorkspaceId: WS.id,
    fresh: true
  })
  seedTrustedRoots(DIR, [ROOT, ELSEWHERE_ROOT])

  const { app, win } = await launchApp(DIR, { server: 'in-process' })
  try {
    const writesTo = writeJournal(DIR)

    // ── At launch: nothing recorded, nothing to step to ───────────────────
    const empty = await snapshot(win)
    t.check('the test seam reads the history', empty !== null && Array.isArray(empty.places), empty)
    t.check(
      'at launch the history is empty',
      empty?.index === -1 && empty?.places.length === 0,
      empty
    )
    t.check(
      'at launch Back and Forward are both disabled',
      (await disabled(win, BACK)) && (await disabled(win, FORWARD))
    )
    t.equal('Back names its key', await win.locator(BACK).getAttribute('title'), 'Back (⌘[)')
    t.equal(
      'Forward names its key',
      await win.locator(FORWARD).getAttribute('title'),
      'Forward (⌘])'
    )

    // ── Setup: three tabs, opened C, B, A so that the sidebar reads A, B, C ─
    const C = await openTerminal(app, 'Tab C')
    let s = await snapshotUntil(win, (x) => x.places.length === 1)
    t.check(
      'the first tab is the first place',
      s?.places.length === 1 && same(current(s)?.tabs, [C]),
      trail(s)
    )
    t.check(
      'at the first place Back is disabled, and Forward with nothing ahead',
      (await disabled(win, BACK)) && (await disabled(win, FORWARD))
    )
    const B = await openTerminal(app, 'Tab B')
    s = await snapshotUntil(win, (x) => x.places.length === 2)
    const A = await openTerminal(app, 'Tab A')
    s = await snapshotUntil(win, (x) => x.places.length === 3)
    t.check(
      'a tab an agent opens is a place each time: C, B, A',
      same(
        s?.places.map((p) => p.tabs),
        [[C], [B], [A]]
      ),
      trail(s)
    )
    // The group with a page, and a page on tab A, used by the walk below.
    const { groupId } = await callMcp(app, 'createGroup', { name: 'Board group' })
    await callMcp(app, 'setGroupView', { groupId, url: BOARD, title: 'Board page' })
    await callMcp(app, 'setSessionView', { sessionId: A, url: DASH, title: 'Dash' })
    const order = await win.evaluate(
      (ids) =>
        [...document.querySelectorAll('[data-sidebar-item-type="session"]')]
          .map((row) => row.getAttribute('data-sidebar-item-id'))
          .filter((id) => ids.includes(id)),
      [A, B, C]
    )
    t.check('CONTROL: the sidebar reads A, B, C from the top', same(order, [A, B, C]), order)

    // ── 1. Three tabs: a row click, ⌘⇧], then Back and Forward both ways ──
    await win.click(rowOf(A))
    await sleep(QUIET_MS)
    s = await snapshot(win)
    t.equal('a click on the tab already on screen records nothing', s?.places.length, 3)

    await win.click(rowOf(B))
    s = await snapshotUntil(win, (x) => x.places.length === 4)
    t.check('a click on B’s row is a place', same(current(s)?.tabs, [B]), trail(s))
    // The road every move is compared with: a click on a tab's own row.
    await sleep(300)
    const afterRow = await focusOf(win)
    const rowTyped = await typedInto(win, writesTo, [A, B, C], 'qzrowprobe')
    t.check('CONTROL: after a click on B’s row, typing reaches B’s terminal', rowTyped === B, {
      typedInto: rowTyped,
      focus: afterRow
    })

    await win.keyboard.press('Meta+Shift+BracketRight')
    s = await snapshotUntil(win, (x) => x.places.length === 5)
    t.check('⌘⇧] to C is a place', same(current(s)?.tabs, [C]) && s.index === 4, trail(s))
    t.check(
      'at the last place Forward is disabled, Back is not',
      (await disabled(win, FORWARD)) && !(await disabled(win, BACK))
    )

    await win.click(BACK)
    s = await snapshotUntil(win, (x) => x.index === 3)
    let seen = await screenUntil(win, (x) => same(x.tiles, [B]))
    t.check(
      'Back (the toolbar button) shows B again',
      s?.index === 3 && same(seen.tiles, [B]) && same(seen.rows, [B]),
      { trail: trail(s), seen }
    )
    t.check('and records no place of its own', s?.places.length === 5, trail(s))
    await sleep(300)
    const afterBackClick = await focusOf(win)
    const backTyped = await typedInto(win, writesTo, [A, B, C], 'qzbackprobe')
    t.check('after a click on Back, typing reaches the restored tab’s terminal', backTyped === B, {
      typedInto: backTyped,
      focus: afterBackClick
    })

    await win.keyboard.press('Meta+BracketLeft')
    s = await snapshotUntil(win, (x) => x.index === 2)
    seen = await screenUntil(win, (x) => same(x.tiles, [A]))
    t.check(
      'Back (⌘[) shows A again',
      s?.index === 2 && same(seen.tiles, [A]) && same(seen.rows, [A]),
      { trail: trail(s), seen }
    )
    await sleep(300)
    const afterBackKey = await focusOf(win)
    const keyTyped = await typedInto(win, writesTo, [A, B, C], 'qzkeyprobe')
    t.check('after ⌘[, typing reaches the restored tab’s terminal', keyTyped === A, {
      typedInto: keyTyped,
      focus: afterBackKey
    })

    await win.keyboard.press('Meta+BracketRight')
    s = await snapshotUntil(win, (x) => x.index === 3)
    seen = await screenUntil(win, (x) => same(x.tiles, [B]))
    t.check('Forward (⌘]) shows B again', s?.index === 3 && same(seen.tiles, [B]), {
      trail: trail(s),
      seen
    })

    await win.click(FORWARD)
    s = await snapshotUntil(win, (x) => x.index === 4)
    seen = await screenUntil(win, (x) => same(x.tiles, [C]))
    t.check('Forward (the toolbar button) shows C again', s?.index === 4 && same(seen.tiles, [C]), {
      trail: trail(s),
      seen
    })
    t.check(
      'back at the last place, Forward is disabled again',
      (await disabled(win, FORWARD)) && !(await disabled(win, BACK))
    )
    t.check(
      'the walk changed no place: C, B, A, B, C',
      same(
        s?.places.map((p) => p.tabs),
        [[C], [B], [A], [B], [C]]
      ),
      trail(s)
    )

    // ── 2. A mosaic: one place, whose focus follows the clicks ────────────
    await win.click(rowOf(B))
    s = await snapshotUntil(win, (x) => x.places.length === 6)
    await win.click(rowOf(A), { modifiers: ['Meta'] })
    s = await snapshotUntil(win, (x) => x.places.length === 7)
    seen = await screenUntil(win, (x) => same(sorted(x.tiles), sorted([A, B])))
    t.check(
      '⌘-click adds A to B: the mosaic is one place',
      same(sorted(current(s)?.tabs ?? []), sorted([A, B])) &&
        same(sorted(seen.tiles), sorted([A, B])),
      { trail: trail(s), seen }
    )
    t.equal('the mosaic starts focused on the tab added', current(s)?.focused, A)
    const mosaicAt = s?.index
    await win.locator(`[data-terminal-tile="${B}"] .xterm`).click()
    s = await snapshotUntil(win, (x) => current(x)?.focused === B)
    t.check(
      'a click on B’s tile moves the focus of the same place',
      current(s)?.focused === B && s.places.length === 7 && s.index === mosaicAt,
      trail(s)
    )
    await win.locator(`[data-terminal-tile="${A}"] .xterm`).click()
    s = await snapshotUntil(win, (x) => current(x)?.focused === A)
    await sleep(QUIET_MS)
    s = await snapshot(win)
    t.check(
      'and a click on A’s tile moves it back, still one place',
      current(s)?.focused === A && s.places.length === 7 && s.index === mosaicAt,
      trail(s)
    )

    // ── 3. Settings on one page, then another: two places ─────────────────
    await win.keyboard.press('Meta+,')
    s = await snapshotUntil(win, (x) => x.places.length === 8)
    // The snapshot names a Settings place by its page, as the settings sidebar writes it.
    t.check(
      'Settings is a place, on its page',
      current(s)?.view === 'settings' && current(s)?.label === 'Settings · General',
      trail(s)
    )
    await win.click('[data-settings-nav-row="keymaps"]')
    s = await snapshotUntil(win, (x) => x.places.length === 9)
    t.check(
      'another page of Settings is another place',
      current(s)?.view === 'settings' &&
        current(s)?.label === 'Settings · Keymaps' &&
        s.places[7]?.label === 'Settings · General',
      trail(s)
    )
    await win.click(BACK)
    s = await snapshotUntil(win, (x) => x.index === 7)
    seen = await screenUntil(win, (x) => x.settings === 'general')
    t.check(
      'Back returns to the first page of Settings',
      s?.index === 7 && seen.settings === 'general',
      { trail: trail(s), seen }
    )
    await win.click(BACK)
    s = await snapshotUntil(win, (x) => x.index === 6)
    seen = await screenUntil(win, (x) => same(sorted(x.tiles), sorted([A, B])))
    t.check(
      'and Back again to the mosaic, Settings gone',
      s?.index === 6 && same(sorted(seen.tiles), sorted([A, B])) && seen.settings === null,
      { trail: trail(s), seen }
    )
    t.equal('with its focus as it was left', current(s)?.focused, A)
    await sleep(300)
    const afterSettings = await focusOf(win)
    const settingsTyped = await typedInto(win, writesTo, [A, B, C], 'qzsettingsprobe')
    t.check(
      'after Back from Settings to the mosaic, typing reaches its focused tab',
      settingsTyped === A,
      { typedInto: settingsTyped, focus: afterSettings }
    )

    // ── 4. A group's page and a tab's page, each left for the mosaic ──────
    await win.click(`[data-sidebar-item-id="${groupId}"] > button`)
    s = await snapshotUntil(win, (x) => x.index === 7 && current(x)?.groupView === groupId)
    seen = await screenUntil(win, (x) => x.title === 'Board page')
    t.check(
      'a group’s page is a place',
      current(s)?.groupView === groupId && seen.title === 'Board page',
      { trail: trail(s), seen }
    )
    t.equal('opening it dropped the places ahead, as a browser does', s?.places.length, 8)
    t.equal('named for its group', current(s)?.label, 'Board group')
    await win.click(BACK)
    s = await snapshotUntil(win, (x) => x.index === 6)
    seen = await screenUntil(win, (x) => x.title === null && x.tiles.length === 2)
    t.check(
      'Back returns to the mosaic under the group’s page',
      s?.index === 6 && same(sorted(seen.tiles), sorted([A, B])) && seen.title === null,
      { trail: trail(s), seen }
    )

    const glyph = win.locator(`[data-sidebar-item-id="${A}"] .sidebar-tab-view[data-view]`)
    await glyph.click()
    s = await snapshotUntil(win, (x) => x.index === 7 && current(x)?.tabView === A)
    seen = await screenUntil(win, (x) => x.title === 'Dash')
    t.check('a tab’s own page is a place', current(s)?.tabView === A && seen.title === 'Dash', {
      trail: trail(s),
      seen
    })
    await win.click(BACK)
    s = await snapshotUntil(win, (x) => x.index === 6)
    seen = await screenUntil(win, (x) => x.title === null && x.tiles.length === 2)
    t.check(
      'Back returns to the mosaic under the tab’s page',
      s?.index === 6 && same(sorted(seen.tiles), sorted([A, B])) && seen.title === null,
      { trail: trail(s), seen }
    )
    // A's page left A the focused tab: nothing the terminal pane watches changed.
    await sleep(300)
    const afterTabPage = await focusOf(win)
    const tabPageTyped = await typedInto(win, writesTo, [A, B, C], 'qztabpageprobe')
    t.check(
      'after Back from a tab’s page to the mosaic, typing reaches its focused tab',
      tabPageTyped === A,
      { typedInto: tabPageTyped, focus: afterTabPage }
    )

    // ── 5. The Analytics page: a place; Back closes it ────────────────────
    const home = win.locator(`[data-plugin-action="home"]`)
    await home.waitFor({ timeout: 20_000 })
    await home.click()
    s = await snapshotUntil(win, (x) => x.index === 7 && current(x)?.plugin !== null)
    seen = await screenUntil(win, (x) => x.plugin === ANALYTICS)
    t.check(
      'the Analytics page is a place',
      String(current(s)?.plugin).startsWith(`page:${ANALYTICS}/`) && seen.plugin === ANALYTICS,
      { trail: trail(s), seen }
    )
    await win.click(BACK)
    s = await snapshotUntil(win, (x) => x.index === 6)
    seen = await screenUntil(win, (x) => x.plugin === null && x.tiles.length === 2)
    t.check(
      'Back closes it and shows the tabs under it',
      s?.index === 6 && seen.plugin === null && same(sorted(seen.tiles), sorted([A, B])),
      { trail: trail(s), seen }
    )
    await sleep(300)
    const afterPlugin = await focusOf(win)
    const pluginTyped = await typedInto(win, writesTo, [A, B, C], 'qzpluginprobe')
    t.check(
      'after Back from the Analytics page, typing reaches the focused tab under it',
      pluginTyped === A,
      { typedInto: pluginTyped, focus: afterPlugin }
    )

    // ── 7. A tab an agent opens: a place, left by Back ────────────────────
    const E = await openTerminal(app, 'Tab E')
    s = await snapshotUntil(win, (x) => x.index === 7 && same(current(x)?.tabs, [E]))
    seen = await screenUntil(win, (x) => same(x.tiles, [E]))
    t.check(
      'a tab opened through the agent tools shows, and is a place',
      same(current(s)?.tabs, [E]) && same(seen.tiles, [E]),
      { trail: trail(s), seen }
    )
    await win.click(BACK)
    s = await snapshotUntil(win, (x) => x.index === 6)
    seen = await screenUntil(win, (x) => x.tiles.length === 2)
    t.check(
      'Back returns to the place before it',
      s?.index === 6 && same(sorted(seen.tiles), sorted([A, B])),
      { trail: trail(s), seen }
    )

    // ── 8. A closed tab is skipped ────────────────────────────────────────
    await win.click(rowOf(A))
    s = await snapshotUntil(win, (x) => x.index === 7 && same(current(x)?.tabs, [A]))
    await win.click(rowOf(B))
    s = await snapshotUntil(win, (x) => x.index === 8 && same(current(x)?.tabs, [B]))
    await win.click(rowOf(C))
    s = await snapshotUntil(win, (x) => x.index === 9 && same(current(x)?.tabs, [C]))
    t.check(
      'A, B, C are three places',
      same(
        s?.places.slice(7).map((p) => p.tabs),
        [[A], [B], [C]]
      ),
      trail(s)
    )
    await callMcp(app, 'closeSession', { sessionId: B })
    await until(async () => ((await win.locator(rowOf(B)).count()) === 0 ? true : null))
    await win.click(BACK)
    s = await snapshotUntil(win, (x) => x.index === 7)
    seen = await screenUntil(win, (x) => same(x.tiles, [A]))
    t.check('with B closed, Back from C lands on A', s?.index === 7 && same(seen.tiles, [A]), {
      trail: trail(s),
      seen
    })
    await win.click(FORWARD)
    s = await snapshotUntil(win, (x) => x.index === 9)
    seen = await screenUntil(win, (x) => same(x.tiles, [C]))
    t.check('and Forward from A skips B too', s?.index === 9 && same(seen.tiles, [C]), {
      trail: trail(s),
      seen
    })

    // ── 9. Two workspaces: Back switches the window back ──────────────────
    t.check(
      'the switcher takes the window to the second workspace',
      await switchWorkspace(win, ELSEWHERE)
    )
    await sleep(QUIET_MS)
    s = await snapshot(win)
    t.equal('an empty workspace is no place', s?.places.length, 10)
    const W = await openTerminal(app, 'Tab W', ELSEWHERE_ROOT)
    s = await snapshotUntil(win, (x) => x.index === 10 && same(current(x)?.tabs, [W]))
    t.check(
      'a tab in the second workspace is a place there',
      current(s)?.workspaceId === ELSEWHERE.id && same(current(s)?.tabs, [W]),
      trail(s)
    )
    await win.click(BACK)
    s = await snapshotUntil(win, (x) => x.index === 9)
    seen = await screenUntil(win, (x) => x.workspace === WS.name && same(x.tiles, [C]))
    t.check(
      'Back switches the window back to the first workspace, on its place',
      s?.index === 9 && seen.workspace === WS.name && same(seen.tiles, [C]),
      { trail: trail(s), seen }
    )
    await win.click(FORWARD)
    s = await snapshotUntil(win, (x) => x.index === 10)
    seen = await screenUntil(win, (x) => x.workspace === ELSEWHERE.name && same(x.tiles, [W]))
    t.check(
      'and Forward to the second one again',
      s?.index === 10 && seen.workspace === ELSEWHERE.name && same(seen.tiles, [W]),
      { trail: trail(s), seen }
    )

    // ── 10. The list behind a right-click ─────────────────────────────────
    await win.click(BACK, { button: 'right' })
    const list = win.locator('[data-nav-list="back"]')
    await list.waitFor({ timeout: 5000 }).catch(() => {})
    const rows = await win.locator('[data-nav-list="back"] [data-nav-entry]').evaluateAll((els) =>
      els.map((el) => ({
        index: Number(el.getAttribute('data-nav-index')),
        text: (el.textContent || '').trim()
      }))
    )
    s = await snapshot(win)
    // The places behind, alive, nearest first: what the history holds, the places that were
    // B alone left out (every other tab of the walk still exists).
    const expected = s.places
      .map((p, i) => ({ i, p }))
      .filter(
        ({ i, p }) =>
          i < s.index && (p.tabs.some((id) => id !== B) || p.groupView || p.tabView || p.plugin)
      )
      .map(({ i }) => i)
      .reverse()
    t.check(
      'a right-click on Back lists the places behind, nearest first, the closed tab’s left out',
      same(
        rows.map((r) => r.index),
        expected
      ),
      { rows, expected, trail: trail(s) }
    )
    t.check(
      'each named, another workspace’s place with that workspace’s name',
      rows[0]?.text === `Tab C · ${WS.name}`,
      rows
    )
    const second = rows[1]?.index
    await win.locator('[data-nav-list="back"] [data-nav-entry]').nth(1).click()
    s = await snapshotUntil(win, (x) => x.index === second)
    seen = await screenUntil(win, (x) => x.workspace === WS.name && same(x.tiles, [A]))
    t.check(
      'a click on the second row goes two places back',
      s?.index === second && seen.workspace === WS.name && same(seen.tiles, [A]),
      { second, trail: trail(s), seen }
    )
    await list.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    t.equal('and closes the list', await list.count(), 0)
    await win.click(BACK, { button: 'right' })
    await list.waitFor({ timeout: 5000 }).catch(() => {})
    t.equal('the list opens again', await list.count(), 1)
    await win.keyboard.press('Escape')
    await list.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    t.equal('Escape closes it', await list.count(), 0)
    t.equal('and moves nothing', (await snapshot(win))?.index, second)

    // ── 11. The mouse's side buttons ──────────────────────────────────────
    await win.click(rowOf(C))
    s = await snapshotUntil(win, (x) => same(current(x)?.tabs, [C]) && x.index === second + 1)
    const before = s?.index
    await sideButton(app, win, 'back', `[data-terminal-tile="${C}"] .xterm`)
    s = await snapshotUntil(win, (x) => x.index === before - 1)
    seen = await screenUntil(win, (x) => same(x.tiles, [A]))
    t.check('the mouse’s back button goes back', s?.index === before - 1 && same(seen.tiles, [A]), {
      trail: trail(s),
      seen
    })
    await sideButton(app, win, 'forward', `[data-terminal-tile="${A}"] .xterm`)
    s = await snapshotUntil(win, (x) => x.index === before)
    seen = await screenUntil(win, (x) => same(x.tiles, [C]))
    t.check('and its forward button goes forward', s?.index === before && same(seen.tiles, [C]), {
      trail: trail(s),
      seen
    })

    // ── 12. The code editor keeps ⌘[ and ⌘] ───────────────────────────────
    await callMcp(app, 'openFile', { path: CODE })
    const editor = win.locator('.cm-editor').first()
    await editor.waitFor({ timeout: 10_000 })
    s = await snapshotUntil(win, (x) => current(x)?.tabs.length === 1 && current(x).tabs[0] !== C)
    const fileAt = s?.index
    const fileTab = current(s)?.tabs[0]
    t.check('a file tab is a place', typeof fileTab === 'string' && fileTab !== C, trail(s))
    const line = win.locator('.cm-editor .cm-line').nth(1)
    await line.click()
    await win.keyboard.press('End')
    const indentOf = async () => ((await line.textContent()) ?? '').match(/^\s*/)[0].length
    const indented = await indentOf()
    await win.keyboard.press('Meta+BracketLeft')
    const outdented = await until(async () => {
      const n = await indentOf()
      return n < indented ? n : null
    })
    await sleep(QUIET_MS)
    s = await snapshot(win)
    t.check('in the code editor ⌘[ outdents the line', outdented !== null && outdented < indented, {
      indented,
      outdented
    })
    t.check(
      'and does not go back',
      s?.index === fileAt && same(current(s)?.tabs, [fileTab]),
      trail(s)
    )
    await win.keyboard.press('Meta+BracketRight')
    const reindented = await until(async () => {
      const n = await indentOf()
      return n > (outdented ?? indented) ? n : null
    })
    await sleep(QUIET_MS)
    s = await snapshot(win)
    t.check(
      'and ⌘] indents it again without going forward',
      reindented !== null && s?.index === fileAt,
      { reindented, trail: trail(s) }
    )
  } finally {
    await app.close()
  }
}
