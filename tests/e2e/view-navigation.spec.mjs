/**
 * A link followed inside a view is never a dead end.
 *
 * The view is an Electron <webview> with a history of its own, and the header
 * carries back, forward and home and names the page the reader is actually on.
 * Before this, the view was an iframe the app could neither read nor drive: a
 * link inside an exos wave page navigated it in place, the header kept the
 * declared title, and nothing brought the wave page back (PRDCT-2247).
 *
 * The spec serves three linked pages from a server of its own and drives the
 * guest from the host (`webview.executeJavaScript`), so every assertion is on
 * what the header shows and what the guest is on — not on the DOM being there.
 * The link policy is asserted at its boundaries: a link to another local
 * port stays in the pane; a link to the wider web opens in the system browser
 * (a stubbed shell.openExternal counts it) and leaves the pane where it was;
 * a 302 to the wider web is treated the same, a 302 to a local page is
 * followed; a file: link does neither; a popup goes to the browser. The
 * guest's confinement is asserted from inside it: no require, no process, no
 * bridge, and a file: src never attaches at all. Delete the `will-navigate` or
 * `will-redirect` handler in view-guests.ts and the matching checks go red;
 * delete the `will-attach-webview` hardening and the confinement checks do.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  fixturePath
} from './harness.mjs'
import { mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import http from 'node:http'

const DIR = userDataDir('view-navigation')
const ROOT = fixturePath('view-navigation-root')
const WS = {
  id: 'eeeeeeee-0000-4000-8000-00000000000f',
  name: 'Views',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Three pages that link each other, plus the two links the policy must refuse. */
function serve() {
  const page = (title, links) =>
    `<html><head><title>${title}</title></head><body>${links
      .map(
        ([href, id, target]) =>
          `<a id="${id}" href="${href}"${target ? ` target="${target}"` : ''}>${id}</a>`
      )
      .join('')}</body></html>`
  const server = http.createServer((req, res) => {
    const routes = {
      '/': page('Home page', [['/second', 'to-second']]),
      '/second': page('Second page', [
        ['/third', 'to-third'],
        ['https://example.com/', 'to-web'],
        ['file:///etc/hosts', 'to-file'],
        ['https://linear.app/antasphere/issue/PRDCT-1', 'to-blank', '_blank']
      ]),
      '/third': page('Third page', [['/', 'to-home']]),
      '/redirects': page('Redirects page', [
        ['/redirect-out', 'to-redirect-out'],
        ['/redirect-local', 'to-redirect-local']
      ])
    }
    const path = req.url.split('?')[0]
    if (path === '/redirect-out') {
      res.writeHead(302, { Location: 'https://example.com/landed' })
      res.end()
      return
    }
    if (path === '/redirect-local') {
      res.writeHead(302, { Location: '/third' })
      res.end()
      return
    }
    const html = routes[path]
    if (!html) {
      res.writeHead(404)
      res.end('nope')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  )
}

/** The header's trail: what it names, where it says the reader is, what is enabled. */
function header(win) {
  return win.evaluate(() => {
    // Every opened view stays mounted, hidden behind the visible one with
    // aria-hidden; the header under test is the one the reader can see.
    const q = (id) =>
      [...document.querySelectorAll(`[data-testid="${id}"]`)].find(
        (el) => !el.closest('[aria-hidden="true"]')
      )
    return {
      title: q('view-title')?.textContent ?? null,
      url: q('view-current-url')?.textContent ?? null,
      back: q('view-nav-back') ? !q('view-nav-back').disabled : null,
      forward: q('view-nav-forward') ? !q('view-nav-forward').disabled : null,
      home: q('view-nav-home') ? !q('view-nav-home').disabled : null
    }
  })
}

/** The guest the reader can see (hidden panes keep theirs mounted). */
const VISIBLE_GUEST = `[...document.querySelectorAll('webview')].find((w) => !w.closest('[aria-hidden="true"]') && w.getBoundingClientRect().width > 0)`

/** What the guest itself reports — the second witness beside the header. */
function guest(win) {
  return win.evaluate(async (pick) => {
    const wv = new Function(`return ${pick}`)()
    if (!wv) return null
    try {
      return { url: wv.getURL(), title: await wv.executeJavaScript('document.title') }
    } catch (e) {
      return { error: String(e) }
    }
  }, VISIBLE_GUEST)
}

/** The guest whose src ends with `suffix` (several pages can be mounted);
 *  waits briefly for it to report its url, which lands after the load. */
function guestBySrc(win, suffix, code) {
  return win.evaluate(
    async ({ suffix, code }) => {
      const wv = [...document.querySelectorAll('webview')].find((w) =>
        (w.getAttribute('src') || '').endsWith(suffix)
      )
      if (!wv) return null
      try {
        let url = ''
        for (let i = 0; i < 20 && !url; i++) {
          url = wv.getURL()
          if (!url) await new Promise((r) => setTimeout(r, 150))
        }
        const out = code
          ? await Promise.race([
              wv.executeJavaScript(code),
              new Promise((r) => setTimeout(() => r('TIMEOUT'), 8000))
            ])
          : null
        return { url, out }
      } catch (e) {
        return { error: String(e) }
      }
    },
    { suffix, code }
  )
}

/** Run code inside the visible guest, as a user gesture unless told otherwise.
 *  A guest that never answers (a page that never loaded) reads 'TIMEOUT'
 *  rather than hanging the run: a check must be able to fail. */
function runInGuest(win, code, gesture = true) {
  return win.evaluate(
    ({ code, gesture, pick }) =>
      Promise.race([
        new Function(`return ${pick}`)().executeJavaScript(code, gesture),
        new Promise((r) => setTimeout(() => r('TIMEOUT'), 8000))
      ]),
    { code, gesture, pick: VISIBLE_GUEST }
  )
}

/** Click a link inside the guest page by its id, AS A USER WOULD: the second
 *  argument of executeJavaScript grants a user gesture. Without it Chromium's
 *  history-manipulation intervention marks the page left behind as skippable
 *  (a script navigated away with no user activation), back does nothing and
 *  canGoBack reads false — the exact symptom under test, produced by the test
 *  itself. Verified 2026-09-11: same click, gesture off → back false with two
 *  history entries; gesture on → back true. */
function clickInGuest(win, id) {
  return win.evaluate(
    ({ id, pick }) =>
      new Function(`return ${pick}`)().executeJavaScript(
        `document.getElementById(${JSON.stringify(id)}).click()`,
        true
      ),
    { id, pick: VISIBLE_GUEST }
  )
}

/** Wait until the header's url ends with `suffix` — and, when `title` is
 *  given, until the header names it: the title lands on its own event after
 *  the url, and reading it on the url alone was flaky. */
async function untilAt(win, suffix, title = null, ms = 6000) {
  const t0 = Date.now()
  const there = (h) => (h.url ?? '').endsWith(suffix) && (title === null || h.title === title)
  let h = await header(win)
  while (!there(h) && Date.now() - t0 < ms) {
    await sleep(150)
    h = await header(win)
  }
  return h
}

function paneCentreTag(win) {
  return win.evaluate(() => {
    const grid = [...document.querySelectorAll('div')].find((d) =>
      (d.className || '').toString().includes('grid gap-2')
    )
    const pane = grid?.parentElement
    if (!pane) return null
    const r = pane.getBoundingClientRect()
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.tagName ?? null
  })
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { server, port } = await serve()
  const HOME = `http://127.0.0.1:${port}`

  const { app, win } = await launchApp(DIR)
  try {
    // Count what leaves for the system browser instead of letting it open.
    await app.evaluate(({ shell }) => {
      globalThis.__e2eExternal = []
      shell.openExternal = async (url) => {
        globalThis.__e2eExternal.push(url)
      }
    })
    const external = () => app.evaluate(() => globalThis.__e2eExternal)

    const opened = await callMcp(app, 'openSession', { mode: 'terminal', cwd: ROOT, name: 'nav' })
    const sessionId = opened?.sessionId
    t.check('a session opens to carry the view', typeof sessionId === 'string', opened)
    await sleep(2500)

    await callMcp(app, 'setSessionView', { sessionId, url: HOME, title: 'Nav' })
    await sleep(1000)
    await win.evaluate(() =>
      [...document.querySelectorAll('[data-sidebar-item-type="session"] span[role="button"]')]
        .find((s) => s.getAttribute('title') === 'Nav')
        ?.click()
    )
    let h = await untilAt(win, `${port}/`)
    t.equal(
      'the view is a web view, painted at the centre of the pane',
      await paneCentreTag(win),
      'WEBVIEW'
    )
    t.equal('CONTROL: at home the header names the declared title', h.title, 'Nav')
    t.equal('CONTROL: at home the url is the home url', h.url, `${HOME}/`)
    t.check(
      'CONTROL: at home nothing is enabled — no back, no forward, no home',
      h.back === false && h.forward === false && h.home === false,
      h
    )

    // Follow a link: the trail starts, the header follows the guest.
    await clickInGuest(win, 'to-second')
    h = await untilAt(win, '/second', 'Second page')
    t.equal('following a link shows the new url in the header', h.url, `${HOME}/second`)
    t.equal("and the guest's own title, not the declared one", h.title, 'Second page')
    t.check(
      'back and home light up, forward stays off',
      h.back === true && h.home === true && h.forward === false,
      h
    )
    let g = await guest(win)
    t.equal('the guest agrees it is on the second page', g?.url, `${HOME}/second`)

    // Back returns; forward goes again.
    await win.click('[data-testid="view-nav-back"]:visible')
    h = await untilAt(win, `${port}/`, 'Nav')
    t.equal('back returns to home', h.url, `${HOME}/`)
    t.check(
      'at home again: back off, forward on, home off',
      h.back === false && h.forward === true && h.home === false,
      h
    )
    t.equal('and the title is the declared one again', h.title, 'Nav')
    await win.click('[data-testid="view-nav-forward"]:visible')
    h = await untilAt(win, '/second')
    t.equal('forward goes to the second page again', h.url, `${HOME}/second`)

    // Two deep, home comes back in one click.
    await clickInGuest(win, 'to-third')
    h = await untilAt(win, '/third')
    t.equal('a second link goes deeper', h.url, `${HOME}/third`)
    await win.click('[data-testid="view-nav-home"]:visible')
    h = await untilAt(win, `${port}/`)
    t.equal('home returns from two deep in one click', h.url, `${HOME}/`)
    g = await guest(win)
    t.equal('and the guest is on the home page', g?.title, 'Home page')

    // The policy's boundaries, from the second page.
    await clickInGuest(win, 'to-second')
    h = await untilAt(win, '/second')
    const beforeWeb = await external()
    await clickInGuest(win, 'to-web')
    await sleep(1500)
    const afterWeb = await external()
    t.equal(
      'a link to the wider web opens in the system browser',
      afterWeb.length - beforeWeb.length,
      1
    )
    t.equal('with that url', afterWeb[afterWeb.length - 1], 'https://example.com/')
    g = await guest(win)
    t.equal('and the pane stays where it was', g?.url, `${HOME}/second`)
    h = await header(win)
    t.equal('so does the header', h.url, `${HOME}/second`)

    await clickInGuest(win, 'to-file')
    await sleep(1500)
    t.equal('a file: link opens nothing', (await external()).length, afterWeb.length)
    g = await guest(win)
    t.equal('and moves nothing', g?.url, `${HOME}/second`)

    // The guest is confined: no node, no bridge — a page in a view has no
    // more power than it would in a browser tab.
    const powers = await runInGuest(
      win,
      '({ require: typeof require, process: typeof process, module: typeof module, bridge: typeof window.electronAPI, node: typeof globalThis.__dirname })',
      false
    )
    t.check(
      'the guest has no node and no bridge',
      Object.values(powers).every((v) => v === 'undefined'),
      powers
    )

    // And no more of the machine than a browser tab would give it — less, in
    // fact: every permission is refused, not asked. Delete the two permission
    // handlers on the view session and this reads "granted" on every row.
    const perms = await runInGuest(
      win,
      `(async () => { const q = {}; for (const n of ['microphone', 'camera', 'geolocation', 'notifications']) { try { q[n] = (await navigator.permissions.query({ name: n })).state } catch (e) { q[n] = 'ERR ' + e.name } } try { await navigator.mediaDevices.getUserMedia({ audio: true }); q.mic = 'GRANTED' } catch (e) { q.mic = e.name } return q })()`
    )
    t.check(
      'the guest is refused every permission',
      ['microphone', 'camera', 'geolocation', 'notifications'].every(
        (n) => perms[n] === 'denied'
      ) && perms.mic === 'NotAllowedError',
      perms
    )

    // A file: src never attaches: the tag is created, the guest is not.
    const fileAttach = await win.evaluate(async () => {
      const wv = document.createElement('webview')
      wv.setAttribute('src', 'file:///etc/hosts')
      wv.style.cssText = 'width:200px;height:100px'
      let attached = false
      wv.addEventListener('dom-ready', () => (attached = true))
      document.body.appendChild(wv)
      await new Promise((r) => setTimeout(r, 2000))
      let id = null
      try {
        id = wv.getWebContentsId()
      } catch {
        id = 'no guest'
      }
      wv.remove()
      return { attached, id }
    })
    t.check(
      'a file: src never attaches a guest',
      fileAttach.attached === false && fileAttach.id === 'no guest',
      fileAttach
    )

    // A popup from the page goes to the browser and moves nothing.
    const beforePopup = (await external()).length
    await runInGuest(win, "window.open('https://example.com/popup')")
    await sleep(1200)
    const afterPopup = await external()
    t.equal('a popup opens in the system browser', afterPopup.length - beforePopup, 1)
    t.equal('with its url', afterPopup[afterPopup.length - 1], 'https://example.com/popup')
    t.equal('and the pane stays where it was', (await guest(win))?.url, `${HOME}/second`)

    // The exos pages open their tasks with target="_blank": same path, same rule.
    await clickInGuest(win, 'to-blank')
    await sleep(1200)
    const afterBlank = await external()
    t.equal(
      'a target=_blank link opens in the system browser',
      afterBlank.length - afterPopup.length,
      1
    )
    t.equal(
      'with its url',
      afterBlank[afterBlank.length - 1],
      'https://linear.app/antasphere/issue/PRDCT-1'
    )
    t.equal('and moves nothing', (await guest(win))?.url, `${HOME}/second`)

    // A redirect is a navigation like any other: out goes to the browser,
    // local is followed.
    await runInGuest(win, "location.assign('/redirects')")
    h = await untilAt(win, '/redirects', 'Redirects page')
    const beforeRedirect = (await external()).length
    await clickInGuest(win, 'to-redirect-out')
    await sleep(1500)
    const afterRedirect = await external()
    t.equal(
      'a 302 to the wider web opens in the system browser',
      afterRedirect.length - beforeRedirect,
      1
    )
    t.equal(
      'with the redirect target',
      afterRedirect[afterRedirect.length - 1],
      'https://example.com/landed'
    )
    t.equal(
      'and the pane stays on the page that redirected',
      (await guest(win))?.url,
      `${HOME}/redirects`
    )
    await clickInGuest(win, 'to-redirect-local')
    h = await untilAt(win, '/third', 'Third page')
    t.equal('a 302 to a local page is followed', h.url, `${HOME}/third`)
    t.equal(
      'and nothing more left for the browser',
      (await external()).length,
      afterRedirect.length
    )

    // Back to the second page for the reload check.
    await runInGuest(win, "location.assign('/second')")
    h = await untilAt(win, '/second', 'Second page')

    // Reload keeps the trail: still on the second page, back still possible.
    await win.click('button[title="Reload"]:visible')
    await sleep(1500)
    h = await header(win)
    t.equal('reload reloads the page the reader is on, not home', h.url, `${HOME}/second`)
    t.check('and the trail survives it', h.back === true, h)

    // Leaving the view and coming back keeps the page (the pane stays mounted).
    await win.click('.segmented-item:visible:has-text("Terminal")')
    await sleep(800)
    await win.evaluate(() =>
      [...document.querySelectorAll('[data-sidebar-item-type="session"] span[role="button"]')]
        .find((s) => s.getAttribute('title') === 'Nav')
        ?.click()
    )
    await sleep(800)
    h = await header(win)
    t.equal('leaving for the terminal and coming back keeps the page', h.url, `${HOME}/second`)

    // ---- A page served from disk gets the same trail, scoped to its folder.
    const FOLDER = `${ROOT}/pages`
    mkdirSync(FOLDER, { recursive: true })
    const filePage = (title, links) =>
      `<html><head><title>${title}</title></head><body>${links
        .map(([href, id]) => `<a id="${id}" href="${href}">${id}</a>`)
        .join('')}</body></html>`
    writeFileSync(
      `${FOLDER}/dash.html`,
      filePage('Dash page', [
        ['two.html', 'to-two'],
        ['../outside.html', 'to-outside'],
        [`${HOME}/second`, 'to-local-http'],
        ['https://example.com/', 'to-web-from-file']
      ])
    )
    writeFileSync(`${FOLDER}/two.html`, filePage('Two page', [['dash.html', 'to-dash']]))
    writeFileSync(`${ROOT}/outside.html`, filePage('Outside page', []))
    // What a page must NOT reach: a file outside its folder, through a symlink
    // planted beside it, and another page's folder, through a guessed token.
    writeFileSync(`${ROOT}/outside-secret.txt`, 'OUTSIDE-ROOT-SECRET')
    if (!existsSync(`${FOLDER}/link.txt`))
      symlinkSync(`${ROOT}/outside-secret.txt`, `${FOLDER}/link.txt`)

    const openedFile = await callMcp(app, 'openSession', {
      mode: 'terminal',
      cwd: ROOT,
      name: 'pages'
    })
    const fileSessionId = openedFile?.sessionId
    t.check(
      'a second session opens to carry a file view',
      typeof fileSessionId === 'string',
      openedFile
    )
    await sleep(1500)
    await callMcp(app, 'setSessionView', {
      sessionId: fileSessionId,
      url: `${FOLDER}/dash.html`,
      title: 'Dash'
    })
    await sleep(800)
    await win.evaluate(() =>
      [...document.querySelectorAll('[data-sidebar-item-type="session"] span[role="button"]')]
        .find((s) => s.getAttribute('title') === 'Dash')
        ?.click()
    )
    h = await untilAt(win, '/pages/dash.html', 'Dash')
    t.equal(
      'a file view is a web view too, painted at the centre of the pane',
      await paneCentreTag(win),
      'WEBVIEW'
    )
    t.check("at home the address line is the file's path", h.url.endsWith('/pages/dash.html'), h)
    t.check(
      'and nothing is enabled',
      h.back === false && h.forward === false && h.home === false,
      h
    )
    let fg = await guestBySrc(win, '/dash.html', 'document.title')
    t.check(
      'the guest is served through clave-preview',
      /^clave-preview:\/\//.test(fg?.url ?? ''),
      fg
    )
    t.equal('and shows the page', fg?.out, 'Dash page')

    // A sibling in the same folder: in the pane, shown as a path.
    await clickInGuest(win, 'to-two')
    h = await untilAt(win, '/pages/two.html', 'Two page')
    t.check(
      'a link to a sibling file stays in the pane and reads as a path',
      h.url.endsWith('/pages/two.html'),
      h
    )
    t.check('with back and home enabled', h.back === true && h.home === true, h)
    await win.click('[data-testid="view-nav-back"]:visible')
    h = await untilAt(win, '/pages/dash.html', 'Dash')
    t.check('back returns to the file', h.url.endsWith('/pages/dash.html') && h.home === false, h)

    // Outside the folder: the protocol answers, the page does not reach it.
    await clickInGuest(win, 'to-outside')
    await sleep(1500)
    // The guest has navigated (its src follows it), so ask the visible one.
    const refusal = await runInGuest(win, 'document.body.innerText', false)
    t.check(
      "a link outside the folder gets the protocol's refusal, not the file",
      /Not found|Outside preview root/.test(refusal ?? ''),
      refusal
    )
    h = await header(win)
    t.check('and back is there to leave it', h.back === true, h)
    await win.click('[data-testid="view-nav-home"]:visible')
    h = await untilAt(win, '/pages/dash.html', 'Dash')
    t.check('home returns to the file', h.url.endsWith('/pages/dash.html'), h)

    // From a file page, the web rules are unchanged.
    await clickInGuest(win, 'to-local-http')
    h = await untilAt(win, '/second', 'Second page')
    t.equal('a link to a local server stays in the pane', h.url, `${HOME}/second`)
    await win.click('[data-testid="view-nav-home"]:visible')
    h = await untilAt(win, '/pages/dash.html', 'Dash')
    const beforeFileWeb = (await external()).length
    await clickInGuest(win, 'to-web-from-file')
    await sleep(1500)
    t.equal(
      'a link to the wider web opens in the system browser',
      (await external()).length - beforeFileWeb,
      1
    )
    fg = await guestBySrc(win, '/dash.html', 'document.title')
    t.equal('and the file page stays', fg?.out, 'Dash page')

    // The folder is the page's whole world: a symlink out of it is refused by
    // the protocol, a guessed token reaches nothing.
    const reach = await runInGuest(
      win,
      `(async () => { const r = {}; for (const [k, u] of [['link', 'link.txt'], ['token', 'clave-preview://deadbeefdeadbeefdeadbeef/dash.html']]) { try { const x = await fetch(u); r[k] = x.status + '|' + (await x.text()).slice(0, 24) } catch (e) { r[k] = 'BLOCKED' } } return r })()`,
      false
    )
    t.check(
      'a symlink out of the folder is refused by the protocol',
      /^403\|/.test(reach?.link ?? ''),
      reach
    )
    t.check(
      'a guessed token reaches nothing',
      reach?.token !== undefined && !/^200/.test(reach.token),
      reach
    )

    // The file view follows its file: an agent rewriting the report reloads it
    // where the reader is.
    writeFileSync(`${FOLDER}/dash.html`, filePage('Dash page v2', [['two.html', 'to-two']]))
    const t1 = Date.now()
    let dashTitle = await runInGuest(win, 'document.title', false)
    while (dashTitle !== 'Dash page v2' && Date.now() - t1 < 8000) {
      await sleep(250)
      dashTitle = await runInGuest(win, 'document.title', false)
    }
    t.equal('a change on disk reloads the file view by itself', dashTitle, 'Dash page v2')

    // ---- An .html FILE TAB is the same guest: it follows the file, and reloads.
    const TAB = `${ROOT}/tab.html`
    const tabPage = (v) =>
      `<html><head><title>Tab</title></head><body><p id="v">version ${v}</p></body></html>`
    writeFileSync(TAB, tabPage('one'))
    const openedTab = await callMcp(app, 'openFile', { path: TAB, view: 'rendered' })
    t.check('an .html file tab opens', !!openedTab && !openedTab.error, openedTab)
    await sleep(3000)
    let tg = await guestBySrc(win, '/tab.html', 'document.getElementById("v").textContent')
    t.equal('the file tab renders the page in a web view', tg?.out, 'version one')

    // The file changes on disk (an editor, an agent): the page follows.
    writeFileSync(TAB, tabPage('two'))
    const t0 = Date.now()
    while ((tg?.out ?? '') !== 'version two' && Date.now() - t0 < 8000) {
      await sleep(250)
      tg = await guestBySrc(win, '/tab.html', 'document.getElementById("v").textContent')
    }
    t.equal('a change on disk reloads the file tab by itself', tg?.out, 'version two')

    // The Reload button reloads the page in place.
    await win.evaluate(() => {
      const wv = [...document.querySelectorAll('webview')].find((w) =>
        (w.getAttribute('src') || '').endsWith('/tab.html')
      )
      wv.__e2eLoads = 0
      wv.addEventListener('did-finish-load', () => (wv.__e2eLoads += 1))
    })
    const reloadBtn = await win.$('[data-testid="file-tab-reload"]')
    t.check('the file tab has a Reload button', !!reloadBtn)
    await reloadBtn?.click()
    await sleep(1500)
    const loads = await win.evaluate(
      () =>
        [...document.querySelectorAll('webview')].find((w) =>
          (w.getAttribute('src') || '').endsWith('/tab.html')
        )?.__e2eLoads
    )
    t.equal('and it reloads the page', loads, 1)
  } finally {
    await app.close()
    server.close()
  }
}
