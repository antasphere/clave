/**
 * A session's attached web view actually REPLACES its terminal.
 *
 * The failure this locks down was invisible in the DOM: the panel mounted, its
 * header rendered with the right title and the View/Terminal toggle, and the
 * terminal still filled the pane underneath. Every "is the panel there" check
 * passed. The panel is `position: absolute` with `z-index: auto`, so it paints
 * in the positioned layer — and so does xterm, whose own wrappers are
 * `position: relative`; among z-index-auto siblings DOM order decides, the grid
 * comes second, and the terminal won. The grid was only hidden for GROUP views.
 *
 * So the assertion that matters is a HIT TEST at the centre of the pane, not a
 * query for the web view: `elementFromPoint` answers "what is actually on top",
 * which is the exact question the bug got wrong. Delete the `viewSession` half
 * of the grid's visibility rule in TerminalGrid.tsx and the xterm assertions
 * below go red while everything else stays green.
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

const DIR = userDataDir('session-view')
const ROOT = fixturePath('session-view-root')
const PAGE = `${ROOT}/dash.html`
const MARKER = 'E2E-SESSION-VIEW-MARKER'
const WS = {
  id: 'eeeeeeee-0000-4000-8000-00000000000e',
  name: 'Views',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** What is painted at the centre of the main pane, and the classes above it. */
function paneCentre(win) {
  return win.evaluate(() => {
    // Anchor on the terminal mosaic and step out to the pane that holds both it
    // and the view panel — the one place the two overlap. A CSS-class query for
    // the pane itself matches sidebar chrome with the same utility classes.
    const grid = [...document.querySelectorAll('div')].find((d) =>
      (d.className || '').toString().includes('grid gap-2')
    )
    const pane = grid?.parentElement
    if (!pane) return { error: 'no main pane' }
    const r = pane.getBoundingClientRect()
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    const chain = []
    for (let el = top; el && chain.length < 10; el = el.parentElement) {
      chain.push((el.className || '').toString())
    }
    return { tag: top?.tagName ?? null, chain }
  })
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(PAGE, `<html><body style="background:#123456"><h1>${MARKER}</h1></body></html>`)
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR)
  try {
    const opened = await callMcp(app, 'openSession', {
      mode: 'terminal',
      cwd: ROOT,
      name: 'viewer'
    })
    const sessionId = opened?.sessionId
    t.check('a session opens to carry the view', typeof sessionId === 'string', opened)
    await sleep(3000)

    // CONTROL: with no view showing, the terminal owns the pane. Without this a
    // hit test that never finds xterm — a broken selector, an unmounted grid —
    // would read as the fix working.
    const before = await paneCentre(win)
    t.check(
      'CONTROL: the terminal owns the pane before the view is opened',
      before.chain?.some((c) => c.includes('xterm')),
      before
    )

    await callMcp(app, 'setSessionView', { sessionId, url: PAGE, title: 'Dash' })
    await sleep(1500)

    // Attach must not steal the pane — the view arrives on the row's icon.
    const afterAttach = await paneCentre(win)
    t.check(
      'attaching alone does not take over the pane',
      afterAttach.chain?.some((c) => c.includes('xterm')),
      afterAttach
    )
    const icon = await win.evaluate(
      () =>
        [
          ...document.querySelectorAll('[data-sidebar-item-type="session"] span[role="button"]')
        ].filter((s) => s.getAttribute('title') === 'Dash').length
    )
    t.equal('and puts a dashboard icon on the row', icon, 1)

    // Open it.
    await win.evaluate(() =>
      [...document.querySelectorAll('[data-sidebar-item-type="session"] span[role="button"]')]
        .find((s) => s.getAttribute('title') === 'Dash')
        ?.click()
    )
    await sleep(2500)

    const frame = await win.evaluate(() => {
      const f = document.querySelector('webview')
      if (!f) return null
      const r = f.getBoundingClientRect()
      return { src: f.getAttribute('src'), width: r.width, height: r.height }
    })
    t.check(
      'the view renders the page through clave-preview',
      /^clave-preview:\/\//.test(frame?.src ?? ''),
      frame
    )
    t.check('at a usable size', (frame?.width ?? 0) > 200 && (frame?.height ?? 0) > 200, frame)

    // THE ASSERTION: the page, not the terminal, is what the user is looking at.
    const shown = await paneCentre(win)
    t.equal('the view is what is painted at the centre of the pane', shown.tag, 'WEBVIEW')
    t.check(
      'and no terminal is left on top of it',
      !shown.chain?.some((c) => c.includes('xterm')),
      shown
    )

    // Back goes to the terminal — the grid must be shown again, not destroyed.
    await win.click('.segmented-item:has-text("Terminal")')
    await sleep(1500)
    const back = await paneCentre(win)
    t.check(
      'the Terminal toggle brings the live terminal back',
      back.chain?.some((c) => c.includes('xterm')),
      back
    )
    t.check(
      'and the session is still alive after being hidden behind the view',
      (await callMcp(app, 'list', {})).sessions.find((s) => s.id === sessionId)?.alive === true
    )
  } finally {
    await app.close()
  }
}
