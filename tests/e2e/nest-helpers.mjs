/**
 * What the three nested-tab specs share (PRDCT-4997, PRDCT-4998):
 * `nested-tabs.spec.mjs`, `nest-drag.spec.mjs` and `nest-tools.spec.mjs`.
 *
 * Not a spec (no `.spec.` in its name, so the runner never runs it), and not
 * the harness, whose hash is pinned: a recording stand-in for an agent CLI,
 * a real pointer drag, and the readers of a tab's record, of the window's
 * saved layout and of the sidebar's nests.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { callMcp, identityOf, recordsRootOf, until, windowLayout } from './harness.mjs'

/**
 * A recording stand-in for the agent CLI under `<root>/bin`: `codex` writes
 * `started-<session id>` when it starts and sets the terminal's title to each
 * line it is given (how a state is put on a tab: `codex | Working`,
 * `[ ! ] Action Required | codex`, `codex | Ready`) and ends on the line
 * `quit` (a stopped tab: its process ended, its row kept); `sh` puts the folder on
 * the PATH of every terminal. No provider and no account is called. Answers
 * the environment to launch the app with.
 */
export function writeRecordingCli(root) {
  mkdirSync(`${root}/bin`, { recursive: true })
  writeFileSync(
    `${root}/bin/codex`,
    `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(root)} + '/started-' + process.env.CLAVE_SESSION_ID, 'recording-only')
const esc = String.fromCharCode(27)
const title = value => process.stdout.write(esc + ']0;' + value + String.fromCharCode(7))
title('codex | Ready')
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const clean = line.split(esc + '[I').join('').split(esc + '[O').join('')
  if (clean.trim() === 'quit') process.exit(0)
  title(clean.trim())
})
`,
    { mode: 0o755 }
  )
  writeFileSync(
    `${root}/bin/sh`,
    `#!/bin/sh
export PATH='${root}/bin':"$PATH"
[ "$1" = '-l' ] && shift
exec /bin/sh "$@"
`,
    { mode: 0o755 }
  )
  return { SHELL: `${root}/bin/sh`, PATH: `${root}/bin:${process.env.PATH}` }
}

/** Open a tab through the window's tool road and wait for the recording CLI
 *  to start in it (an agent tab). Answers its session id. */
export async function openTab(
  app,
  root,
  name,
  { mode = 'codex', caller, attachToParent, groupId } = {}
) {
  const result = await callMcp(app, 'openSession', {
    cwd: root,
    name,
    mode,
    callerSessionId: caller,
    attachToParent,
    groupId
  })
  assert.ok(result?.sessionId, JSON.stringify(result))
  if (mode === 'codex')
    assert.ok(
      await until(() => existsSync(`${root}/started-${result.sessionId}`)),
      `the recording CLI must start for ${name}`
    )
  return result.sessionId
}

/** Put a state on an agent tab through its recording CLI and wait for the
 *  listing to say it. */
export async function sayState(app, win, id, title, state) {
  await win.evaluate(({ id, title }) => window.electronAPI.writeSession(id, title + '\n'), {
    id,
    title
  })
  assert.ok(
    await until(
      async () =>
        (await callMcp(app, 'list', {})).sessions.find((s) => s.id === id)?.agentState === state
    ),
    `${id} must reach ${state}`
  )
}

/** Run `fn(store, arg)` in the window against the session store's test hook. */
export function store(win, fn, arg) {
  return win.evaluate(
    ({ source, arg }) =>
      new Function('store', 'arg', `return (${source})(store, arg)`)(
        window.__claveSessionStoreForTests,
        arg
      ),
    { source: fn.toString(), arg }
  )
}

/** The store's nesting, as the sidebar calls it: `{ ok }` or `{ ok, error }`. */
export const nestBy = (win, id, under) =>
  store(win, (s, a) => s.getState().nestSession(a.id, a.under), { id, under })
export const detachBy = (win, id) => store(win, (s, a) => s.getState().detachSession(a), id)
export const setNestOpen = (win, id, open) =>
  store(win, (s, a) => s.getState().setNestExpanded(a.id, a.open), { id, open })

// ── The sidebar ──────────────────────────────────────────────────────────

export const rowSel = (id) => `[data-sidebar-item-id="${id}"]`
/** A tab's own row (never its copy inside a nest). */
export const ownRowSel = (id) => `[data-sidebar-item-id="${id}"]:not([data-sidebar-nested-root])`
/** A tab's row inside the nest of `parent`. */
export const nestedRowSel = (parent, id) =>
  `[data-sidebar-nested-root="${parent}"][data-sidebar-item-id="${id}"]`
/** The count toggle on a tab's own row. */
export const toggleSel = (id) => `${rowSel(id)} > .sidebar-item .sidebar-nest-toggle`

/** How many rows of this tab the person sees: a folded nest keeps its rows in
 *  the DOM (inert), so those are not counted. */
export const visibleRows = (win, id) =>
  win.evaluate(
    (sel) => document.querySelectorAll(`${sel}:not([data-nest-collapsed="true"] *)`).length,
    rowSel(id)
  )

/** The count toggle of a tab: null when it has none. */
export const toggleOf = (win, id) =>
  win.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    return {
      count: Number(el.querySelector('.sidebar-nest-count')?.textContent ?? NaN),
      expanded: el.getAttribute('aria-expanded'),
      open: el.getAttribute('data-open'),
      status: el.getAttribute('data-status'),
      label: el.getAttribute('aria-label')
    }
  }, toggleSel(id))

/** The ids of the session rows on screen, top to bottom (rows of a folded
 *  nest or of a collapsed group are not on screen). */
export const rowsOnScreen = (win) =>
  win.evaluate(() =>
    [...document.querySelectorAll('[data-sidebar-item-type="session"]')]
      .filter(
        (el) =>
          !el.closest('[data-nest-collapsed="true"]') &&
          !el.closest('[data-group-collapsed="true"]')
      )
      .map((el) => el.dataset.sidebarItemId)
  )

/** The row marked as the one the dragged tab would be nested under. */
export const ontoMarked = (win) =>
  win.evaluate(() =>
    [...document.querySelectorAll('.sidebar-item[data-drop-onto="true"]')].map(
      (el) => el.closest('[data-sidebar-item-id]')?.dataset.sidebarItemId ?? '?'
    )
  )

/** Where the drop line is: the id of the row directly below it in DOM order,
 *  'end' at the foot, null when no line is shown. */
export const activeLineBefore = (win) =>
  win.evaluate(() => {
    const gap = document.querySelector('.sidebar-drop-gap-active')
    if (!gap) return null
    let el = gap.nextElementSibling
    while (el && !el.matches('[data-sidebar-item-id]'))
      el = el.querySelector?.('[data-sidebar-item-id]') ?? el.nextElementSibling
    return el?.dataset.sidebarItemId ?? 'end'
  })
/** Whether any drop line is drawn. */
export const dropLines = (win) =>
  win.evaluate(() => document.querySelectorAll('.sidebar-drop-line').length)

// ── A real pointer drag (copied from sidebar-dnd.spec.mjs) ────────────────

export async function centerOf(win, selector, { yFraction = 0.5 } = {}) {
  const box = await win.locator(selector).first().boundingBox()
  if (!box) throw new Error(`no box for ${selector}`)
  return { x: box.x + box.width / 2, y: box.y + box.height * yFraction }
}

/** One pointer per window: where the pressed pointer is (kept by dragTo and
 *  hoverTo). */
const pointers = new WeakMap()

/** Move the already-pressed pointer to `target` (a point or a getter),
 *  re-reading a getter while hovering the way a hand tracks a row that moved.
 *  Never presses. */
export async function hoverTo(win, target) {
  const aim = typeof target === 'function' ? target : () => target
  const glide = async (to) => {
    const at = pointers.get(win) ?? { x: 0, y: 0 }
    const steps = 10
    for (let i = 1; i <= steps; i++) {
      await win.mouse.move(at.x + ((to.x - at.x) * i) / steps, at.y + ((to.y - at.y) * i) / steps)
      await win.waitForTimeout(20)
    }
    pointers.set(win, to)
  }
  await glide(await aim())
  for (let i = 0; i < 4; i++) {
    await win.waitForTimeout(150)
    const to = await aim()
    const at = pointers.get(win)
    if (Math.abs(to.y - at.y) < 1 && Math.abs(to.x - at.x) < 1) break
    await glide(to)
  }
  await win.waitForTimeout(150)
}

/** Press on `from` and hold the pointer over `target`. */
export async function dragTo(win, from, target) {
  await win.mouse.move(from.x, from.y)
  await win.mouse.down()
  pointers.set(win, { x: from.x, y: from.y })
  await hoverTo(win, target)
}
export async function release(win) {
  await win.mouse.up()
  await win.waitForTimeout(700)
}
/** End a drag without a drop. */
export async function cancelDrag(win) {
  await win.keyboard.press('Escape')
  await win.mouse.up()
  await win.waitForTimeout(400)
}

// ── What is written ──────────────────────────────────────────────────────

/** A session's record file as the server wrote it, under a records folder. */
export function recordIn(recordsRoot, id) {
  const dir = path.join(recordsRoot, 'session-records')
  if (!existsSync(dir)) return null
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const r = JSON.parse(readFileSync(path.join(dir, f), 'utf-8'))
      if (r.id === id) return r
    } catch {
      // A file being written: read it on the next poll.
    }
  }
  return null
}
/** A session's record file for the app on `dir`. */
export const recordOf = (dir, id) => recordIn(recordsRootOf(dir), id)

/** The saved sidebar layout of the app's first window. */
export async function layoutOf(dir, win) {
  const { windowKey } = await identityOf(win)
  return windowLayout(dir, windowKey)
}

/** The ids of a layout in the order they are drawn: top-level items, with a
 *  group's sessions in place of the group. */
export function flatOrder(layout) {
  if (!layout) return []
  const groups = new Map((layout.groups ?? []).map((g) => [g.id, g]))
  return (layout.displayOrder ?? []).flatMap((id) =>
    groups.has(id) ? [id, ...(groups.get(id).sessionIds ?? [])] : [id]
  )
}

/** `nestedUnder` of every tab, from the window's own listing. */
export async function nestedUnderAll(app) {
  const l = await callMcp(app, 'list', {})
  return Object.fromEntries((l?.sessions ?? []).map((s) => [s.id, s.nestedUnder ?? null]))
}
