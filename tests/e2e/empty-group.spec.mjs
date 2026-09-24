/**
 * An emptied group keeps its place.
 *
 * Closing a group's last tab used to make the group vanish with it: the user
 * opens a group, closes its one session, and cannot find the group again.
 * The group had not been deleted — it was in the store, hidden for holding
 * nothing, and pruned for good at the next launch. An empty group is a
 * normal state now, in the real app:
 *
 *  1. The card stays, its rail holding a "No sessions" row instead of the
 *     tab — and it is EXACTLY as tall as it was with one session, so nothing
 *     below it jumps when the last tab closes.
 *  2. The header still works: a click folds the empty card, another unfolds it.
 *  3. The row is the group's drop zone: a loose tab dragged onto it joins the
 *     group, and the row makes way for it.
 *  4. The next launch brings the empty group back, empty (the boot merge no
 *     longer prunes it).
 *
 * Fails if the old behaviour comes back at any of those four points: a card
 * that disappears, a card that shrinks to its header, a drop that does
 * nothing, or a group missing after the restart.
 */
import { mkdirSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  until,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('empty-group')
const ROOT = fixturePath('empty-group-root')
const WS = {
  id: 'abababab-0000-4000-8000-00000000000a',
  name: 'Empty',
  rootDir: ROOT,
  createdAt: 1
}

const cardSel = (groupId) => `.group-scope:has([data-sidebar-item-id="${groupId}"][data-sidebar-item-type="group"])`
const rowSel = (id) => `[data-sidebar-item-id="${id}"]`
const emptyRowSel = (groupId) => `[data-sidebar-empty-group="${groupId}"]`

/** The card of `groupId` as the user sees it: whether it is drawn, its height,
 *  the member rows in its rail, and the placeholder's text if it shows one. */
function card(win, groupId) {
  return win.evaluate(
    ({ cardSel, emptyRowSel }) => {
      const el = document.querySelector(cardSel)
      if (!el) return null
      const rect = el.getBoundingClientRect()
      const empty = el.querySelector(emptyRowSel)
      return {
        height: Math.round(rect.height),
        rows: [...el.querySelectorAll('.group-rail [data-sidebar-item-id]')].map((r) => r.dataset.sidebarItemId),
        placeholder: empty ? (empty.textContent || '').trim() : null,
        placeholderHeight: empty ? Math.round(empty.getBoundingClientRect().height) : null
      }
    },
    { cardSel: cardSel(groupId), emptyRowSel: emptyRowSel(groupId) }
  )
}

async function centerOf(win, selector) {
  const box = await win.locator(selector).boundingBox()
  if (!box) throw new Error(`no box for ${selector}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** A real pointer drag from `from` to `to`, past the 5px threshold in steps,
 *  hovering long enough for the debounced drop indicator before releasing. */
async function drag(win, from, to) {
  await win.mouse.move(from.x, from.y)
  await win.mouse.down()
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    await win.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
    await win.waitForTimeout(20)
  }
  await win.waitForTimeout(500)
  await win.mouse.up()
  await win.waitForTimeout(600)
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  let { app, win } = await launchApp(DIR)
  try {
    // ── The group, with one tab: the reference height ──
    const group = await callMcp(app, 'createGroup', { name: 'Lane' })
    await win.waitForTimeout(400)
    const fresh = await card(win, group.groupId)
    t.check(
      'a group created empty is drawn at once, on its "No sessions" row',
      fresh?.placeholder === 'No sessions' && fresh.rows.length === 0,
      fresh
    )

    const member = await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal', name: 'only-tab' })
    await callMcp(app, 'moveSession', { sessionId: member.sessionId, groupId: group.groupId })
    await win.waitForTimeout(800)
    const withOne = await card(win, group.groupId)
    t.check(
      'the group holds its one tab and no placeholder',
      withOne?.rows.length === 1 && withOne.placeholder === null,
      withOne
    )
    const rowHeight = await win.evaluate(
      (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().height ?? 0),
      `${rowSel(member.sessionId)} .sidebar-item`
    )

    // ── 1. Close the last tab: the card stays, same height ──
    await callMcp(app, 'closeSession', { sessionId: member.sessionId })
    await win.waitForTimeout(1000)
    const listed = await callMcp(app, 'list', {})
    t.check(
      'the group is still in the layout after its last tab closed',
      listed.groups.some((g) => g.id === group.groupId && g.sessionIds.length === 0),
      listed.groups
    )
    const emptied = await card(win, group.groupId)
    t.check('the card is still drawn', !!emptied, 'no card for the group')
    t.equal('and it says "No sessions"', emptied?.placeholder, 'No sessions')
    t.equal('the placeholder row is exactly one session row tall', emptied?.placeholderHeight, rowHeight)
    t.equal('so the empty card is exactly as tall as it was with one tab', emptied?.height, withOne?.height)

    // ── 2. The header still folds and unfolds the empty card ──
    await win.click(rowSel(group.groupId))
    await win.waitForTimeout(600)
    const folded = await card(win, group.groupId)
    t.check('a click on the header folds the empty card', !!folded && folded.height < emptied.height, {
      folded: folded?.height,
      open: emptied?.height
    })
    await win.click(rowSel(group.groupId))
    await win.waitForTimeout(600)
    const unfolded = await card(win, group.groupId)
    t.equal('and a second click unfolds it to the same height', unfolded?.height, emptied?.height)

    // ── 3. The row is the drop zone: a loose tab dropped on it joins ──
    const loose = await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal', name: 'loose-tab' })
    await win.waitForTimeout(800)
    await drag(win, await centerOf(win, rowSel(loose.sessionId)), await centerOf(win, emptyRowSel(group.groupId)))
    const joined = await card(win, group.groupId)
    t.check(
      'the tab dropped on "No sessions" joined the group, and the row made way',
      joined?.rows.join(',') === loose.sessionId && joined.placeholder === null,
      joined
    )
    t.equal('the card is as tall with the new tab as with the placeholder', joined?.height, emptied?.height)

    // ── 4. The restart: the empty group comes back, empty ──
    await callMcp(app, 'closeSession', { sessionId: loose.sessionId })
    await win.waitForTimeout(1500)
    await app.close()
    app = null
    await new Promise((r) => setTimeout(r, 1500))

    const second = await launchApp(DIR, { settleMs: 6000 })
    app = second.app
    win = second.win
    const back = await until(async () => {
      const list = await callMcp(app, 'list', {})
      return list.groups.some((g) => g.id === group.groupId) ? list : null
    })
    t.check(
      'the empty group is back after the restart',
      !!back && back.groups.find((g) => g.id === group.groupId)?.sessionIds.length === 0,
      back?.groups
    )
    const rebooted = await card(win, group.groupId)
    t.check(
      'drawn on its "No sessions" row, at the same height',
      rebooted?.placeholder === 'No sessions' && rebooted.height === emptied?.height,
      { rebooted, expected: emptied?.height }
    )
  } finally {
    if (app) await app.close()
  }
}
