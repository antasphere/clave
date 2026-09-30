/**
 * A rendered HTML page SURVIVES being switched away from and back (PRDCT-2122).
 *
 * The bug: `TerminalGrid` rendered only the SELECTED file tabs, so deselecting an
 * .html tab unmounted its `FileViewer`, its `HtmlPreviewFrame`, and the iframe's
 * whole document. Coming back mounted a fresh one — a full reload. The scroll was
 * at the top again and every piece of state the page held (an open in-page tab, a
 * filter, a chart's zoom) was back to its initial value. Nothing errored; the page
 * just silently started over. The terminals one loop above have always done the
 * opposite — render all, hide the unselected — which is the only reason a terminal
 * survives a tab switch.
 *
 * WHAT THIS SPEC HAS TO ASSERT, and why the obvious check is worthless: "an iframe
 * is present after coming back" passes just as happily on the broken code, because
 * a remount also leaves an iframe in the DOM. So does "the src is right". The only
 * question that separates fixed from broken is whether it is the SAME LIVE
 * DOCUMENT, and there are two independent ways to see that from the parent, both
 * used below:
 *
 *   1. ELEMENT IDENTITY. Stamp an expando on the iframe element before switching
 *      away. React re-creates the DOM node on remount, so a surviving stamp means
 *      the element was never destroyed.
 *   2. LOAD COUNT. The `load` event fires on the iframe element and is observable
 *      cross-origin (the frame is an opaque origin — sandbox without
 *      allow-same-origin — so its scroll and its internals are NOT readable, which
 *      is exactly why the fix has to preserve the document rather than restore it).
 *      A document that reloaded fires load again. Still 1 means it never reloaded.
 *
 * Both are checked after a REAL tab switch driven through the store the sidebar
 * writes, and a CONTROL asserts the page genuinely reloads when it should (an
 * explicit reload bumps the count), so a counter wired to nothing cannot read as a
 * pass.
 *
 *   3. THE SCROLL OFFSET ITSELF. The app cannot read it, but the test driver can
 *      evaluate inside the frame, so the user-facing symptom is asserted directly
 *      on both surfaces (file tab and session view), not inferred from 1 and 2.
 *
 * MUTATION-TESTED against the pre-fix source (git checkout HEAD~1 on the layout
 * folder): 11 of these 28 assertions go red — identity, load count and scroll,
 * on both surfaces — and which ones STAY green is the point: "coming back, the
 * preview is there" and "at a usable size" pass on the broken code. Those are the
 * checks a spec written the obvious way would have made, and they would have
 * shipped the bug.
 *
 * What this spec does NOT pin down, deliberately, is the `visibility: hidden`
 * choice: swapping it for `display: none` leaves every assertion here green,
 * because Chromium keeps a display:none iframe's document and scroll alive too.
 * That choice is about the layout box (a frame with no box comes back needing a
 * re-layout, so a page that sizes itself on resize redoes that work every switch),
 * not about survival, and it is written down as such in TerminalGrid.tsx rather
 * than asserted here as something it is not.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  fixturePath
} from './harness.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const DIR = userDataDir('html-preview-state')
const ROOT = fixturePath('html-preview-state-root')
const PAGE = `${ROOT}/report.html`
const OTHER = `${ROOT}/other.txt`
const VIEW_PAGE = `${ROOT}/dash.html`
const WS = {
  id: 'eeeeeeee-0000-4000-8000-0000000000a2',
  name: 'Previews',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The preview web view, its identity stamp, and how many times it has loaded. */
function frameState(win) {
  return win.evaluate(() => {
    const f = document.querySelector('webview[src^="clave-preview://"]')
    if (!f) return { present: false }
    return {
      present: true,
      stamp: f.__e2eStamp ?? null,
      loads: f.__e2eLoads ?? null,
      src: f.getAttribute('src'),
      // Is it still laid out? A frame collapsed to zero comes back needing a
      // full re-layout, which is the reload this change exists to remove.
      width: f.getBoundingClientRect().width,
      height: f.getBoundingClientRect().height
    }
  })
}

/** Mark the current web view and start counting its loads. */
function stampFrame(win, stamp) {
  return win.evaluate((s) => {
    const f = document.querySelector('webview[src^="clave-preview://"]')
    if (!f) return false
    f.__e2eStamp = s
    // It has already loaded once by now; count from there.
    f.__e2eLoads = 1
    f.addEventListener('did-finish-load', () => {
      f.__e2eLoads = (f.__e2eLoads ?? 0) + 1
    })
    return true
  }, stamp)
}

/** Click a tab's real sidebar row — the same path the user takes. Returns false
 *  if the row is not there, so a spec fails on a bad selector instead of
 *  silently asserting against a switch that never happened. */
function clickSidebarTab(win, id) {
  return win.evaluate((tabId) => {
    const row = document.querySelector(`[data-sidebar-item-id="${tabId}"] button`)
    if (!row) return false
    row.click()
    return true
  }, id)
}

/** Run code inside the preview's own document. The APP cannot look in here
 *  (a guest is another process) — that is the whole reason the fix preserves
 *  the document instead of restoring state — but the web view's
 *  executeJavaScript can, which is what lets the scroll offset itself be
 *  asserted rather than inferred. `needle` picks the guest by src when two
 *  pages are mounted. Null = no such element; 'detached' = the element is
 *  there but its document is gone, which IS the bug. */
async function inPreview(win, code, needle = '') {
  return win.evaluate(
    async ({ code, needle }) => {
      const f = [...document.querySelectorAll('webview[src^="clave-preview://"]')].find((x) =>
        (x.getAttribute('src') || '').includes(needle)
      )
      if (!f) return null
      try {
        return await f.executeJavaScript(code)
      } catch {
        return 'detached'
      }
    },
    { code, needle }
  )
}

/** Scroll the preview's document and report where it landed. */
function scrollPreviewTo(win, y, needle = '') {
  return inPreview(win, `(window.scrollTo(0, ${y}), window.scrollY)`, needle)
}

/** Where the preview's document is scrolled to now (null = no frame). */
function previewScrollY(win, needle = '') {
  return inPreview(win, 'window.scrollY', needle)
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  // A page tall enough to scroll and holding state of its own, so what it stands
  // for in the report — a dashboard with tabs — is what is actually on screen.
  writeFileSync(
    PAGE,
    `<html><body style="margin:0">
       <div style="height:4000px;background:linear-gradient(#123456,#654321)">
         <h1 id="h">E2E-PREVIEW-STATE</h1>
       </div>
       <script>window.__bootCount = (window.__bootCount || 0) + 1</script>
     </body></html>`
  )
  writeFileSync(OTHER, 'a second tab to switch to\n')
  writeFileSync(
    VIEW_PAGE,
    '<html><body style="margin:0"><div style="height:3000px"><h1>DASH</h1></div></body></html>'
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR)
  try {
    // Open the HTML page as a file tab, rendered.
    const openedHtml = await callMcp(app, 'openFile', { path: PAGE, view: 'rendered' })
    const htmlTabId = openedHtml?.fileTabId
    t.check('the .html opens as a file tab', typeof htmlTabId === 'string', openedHtml)
    await sleep(2500)

    const first = await frameState(win)
    t.check('and renders through the clave-preview protocol', first.present, first)
    t.check('at a usable size', (first.width ?? 0) > 100 && (first.height ?? 0) > 100, first)
    t.check('the frame accepts an identity stamp', await stampFrame(win, 'ORIGINAL'), first)

    // CONTROL — the counter is wired to something real. Force a reload the way
    // the app does (a new key on the frame) and the count must move. Without
    // this, a load counter that never fires would make every "still 1" below
    // pass on broken code.
    await win.evaluate(() => {
      const f = document.querySelector('webview[src^="clave-preview://"]')
      f.reload()
    })
    await sleep(1500)
    const reloaded = await frameState(win)
    t.equal('CONTROL: a real reload is observed by the counter', reloaded.loads, 2)
    t.equal('CONTROL: and the element itself survives a reload', reloaded.stamp, 'ORIGINAL')

    // Re-stamp from a known baseline for the assertions that matter.
    await win.evaluate(() => {
      const f = document.querySelector('webview[src^="clave-preview://"]')
      f.__e2eLoads = 1
    })

    // Scroll the page — the state the report is about — before looking away.
    const scrolled = await scrollPreviewTo(win, 1500)
    t.equal('the page scrolls (the fixture is tall enough to)', scrolled, 1500)

    // Open a SECOND tab and switch to it — a real switch through the store the
    // sidebar writes, which is what deselects the html tab.
    const openedOther = await callMcp(app, 'openFile', { path: OTHER })
    const otherTabId = openedOther?.fileTabId
    t.check('a second file tab opens to switch to', typeof otherTabId === 'string', openedOther)
    await sleep(1500)

    const clickedAway = await clickSidebarTab(win, otherTabId)
    t.check("the second tab's sidebar row is clickable", clickedAway, otherTabId)
    await sleep(2000)

    // THE ASSERTIONS. Same element, no new load — the document never died.
    const back0 = await frameState(win)
    t.check('the preview frame is still mounted while another tab is shown', back0.present, back0)
    t.equal('and it is the SAME element (never unmounted)', back0.stamp, 'ORIGINAL')
    t.equal('and it never reloaded while hidden', back0.loads, 1)

    // Switch back to the HTML tab.
    const clickedBack = await clickSidebarTab(win, htmlTabId)
    t.check("the html tab's sidebar row is clickable", clickedBack, htmlTabId)
    await sleep(2000)

    const back = await frameState(win)
    t.check('coming back, the preview is there', back.present, back)
    t.equal('it is STILL the same element — no remount', back.stamp, 'ORIGINAL')
    t.equal('and it never reloaded across the switch', back.loads, 1)
    t.check(
      'and it is laid out at a usable size again',
      (back.width ?? 0) > 100 && (back.height ?? 0) > 100,
      back
    )
    // THE USER-FACING ASSERTION: the scroll position is where it was left.
    t.equal('and the scroll offset survived the switch', await previewScrollY(win), 1500)

    // ── The other surface: a session's attached web view ─────────────────────
    // A view panel used to mount only while it was the active one; now an
    // opened panel stays mounted and hidden. Same assertions, driven through
    // the row's dashboard icon and the View/Terminal toggle, as session-view
    // does.
    const opened = await callMcp(app, 'openSession', {
      mode: 'terminal',
      cwd: ROOT,
      name: 'viewer'
    })
    const sessionId = opened?.sessionId
    t.check('a session opens to carry a view', typeof sessionId === 'string', opened)
    await sleep(2500)
    await callMcp(app, 'setSessionView', { sessionId, url: VIEW_PAGE, title: 'Dash' })
    await sleep(1000)
    const openView = () =>
      win.evaluate(() => {
        const icon = [
          ...document.querySelectorAll('[data-sidebar-item-type="session"] span[role="button"]')
        ].find((s) => s.getAttribute('title') === 'Dash')
        icon?.click()
        return !!icon
      })
    t.check('the view opens from the row icon', await openView())
    await sleep(2500)

    // Stamp the VIEW's frame — a different file, so the two frames are told
    // apart by src, never by which one querySelector happens to find first.
    const viewFrameState = () =>
      win.evaluate((needle) => {
        const f = [...document.querySelectorAll('webview[src^="clave-preview://"]')].find((x) =>
          x.getAttribute('src').includes(needle)
        )
        if (!f) return { present: false }
        return { present: true, stamp: f.__e2eStamp ?? null, loads: f.__e2eLoads ?? null }
      }, 'dash.html')
    const viewStamped = await win.evaluate((needle) => {
      const f = [...document.querySelectorAll('webview[src^="clave-preview://"]')].find((x) =>
        x.getAttribute('src').includes(needle)
      )
      if (!f) return false
      f.__e2eStamp = 'VIEW'
      f.__e2eLoads = 1
      f.addEventListener('did-finish-load', () => {
        f.__e2eLoads = (f.__e2eLoads ?? 0) + 1
      })
      return true
    }, 'dash.html')
    t.check("the session view's frame is rendered and stamped", viewStamped)
    const viewScrolled = await scrollPreviewTo(win, 900, 'dash.html')
    t.equal('the view page scrolls', viewScrolled, 900)

    // Leave the view for the terminal, then come back through the icon.
    await win.click('.segmented-item:has-text("Terminal")')
    await sleep(1500)
    const viewHidden = await viewFrameState()
    t.check('the view stays mounted behind the terminal', viewHidden.present, viewHidden)
    t.equal('as the same element', viewHidden.stamp, 'VIEW')
    t.check('the view reopens from the row icon', await openView())
    await sleep(1500)
    const viewBack = await viewFrameState()
    t.equal('coming back to the view, it is the same element', viewBack.stamp, 'VIEW')
    t.equal('and it never reloaded', viewBack.loads, 1)
    let viewScrollBack = null
    try {
      viewScrollBack = await previewScrollY(win, 'dash.html')
    } catch {
      viewScrollBack = 'detached'
    }
    t.equal("and the view's scroll offset survived", viewScrollBack, 900)
  } finally {
    await app.close()
  }
}
