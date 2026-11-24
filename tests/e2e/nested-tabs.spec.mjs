/**
 * A tab nested under another is a row under it, folded behind a count on
 * the parent's row (PRDCT-4998; it replaces the pop-up « Session and
 * subagents » menu of #216, whose spec this file was).
 *
 * Proves, on the real app with a recording stand-in CLI: a tab an agent
 * opens with `attachToParent` is nested (a plain terminal too), one toggle
 * per parent counts every tab under it at any depth; the toggle folds and
 * unfolds by click, Enter and Space without selecting the parent or starting
 * a drag; while folded it carries the state of the nested tab that most asks
 * for attention, in the status tokens' colours, and leaves the parent's own
 * status alone; cycling to a nested tab unfolds its nest; the digit shortcuts
 * count the rows on screen; search shows a nested tab as a plain row; rename
 * in place works on the parent and on a nested row; closing tabs adjusts the
 * count and re-roots survivors; the row's menu offers `Attach to` (only the
 * tabs the rule allows) and `Detach from “<name>”`; and the geometry holds
 * in the four themes.
 *
 * Fails if: a nested tab keeps an ordinary row, the count is wrong or shown
 * on a parent with none, the toggle selects or drags, the folded signal is
 * missing or takes the parent's status, cycling to a nested tab leaves it out
 * of sight, the digit shortcuts count folded rows, the menu offers a tab the
 * rule refuses, a detached tab lands elsewhere than right after its former
 * parent, or the toggle crowds the parent's name.
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  callMcp,
  until
} from './harness.mjs'
import {
  writeRecordingCli,
  openTab,
  rowSel,
  ownRowSel,
  nestedRowSel,
  toggleSel,
  toggleOf,
  visibleRows,
  rowsOnScreen,
  ontoMarked,
  activeLineBefore,
  recordOf
} from './nest-helpers.mjs'

const DIR = userDataDir('nested-tabs')
const ROOT = fixturePath('nested-tabs-root')
const WS = {
  id: 'nested-tabs',
  name: 'Nested tabs',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

export async function run(t) {
  // t.equal compares with Object.is: arrays and objects compare as JSON.
  const eq = (name, actual, expected, detail) =>
    t.check(
      name,
      JSON.stringify(actual) === JSON.stringify(expected),
      detail ?? { expected, got: actual }
    )
  mkdirSync(ROOT, { recursive: true })
  const env = writeRecordingCli(ROOT)
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win } = await launchApp(DIR, { server: 'in-process', env })
  try {
    const parent = await openTab(app, ROOT, 'Coordinator')
    const child = await openTab(app, ROOT, 'Explorer', { caller: parent, attachToParent: true })
    const nested = await openTab(app, ROOT, 'Verifier', { caller: child, attachToParent: true })
    const page = await openTab(app, ROOT, 'Page server', {
      mode: 'terminal',
      caller: parent,
      attachToParent: true
    })
    const terminal = await openTab(app, ROOT, 'Dev terminal', { mode: 'terminal', caller: parent })
    const names = {
      [parent]: 'Coordinator',
      [child]: 'Explorer',
      [nested]: 'Verifier',
      [page]: 'Page server',
      [terminal]: 'Dev terminal'
    }
    const named = (ids) => ids.map((id) => names[id] ?? id)
    const row = (id) => win.locator(ownRowSel(id))
    const parentItem = () => row(parent).locator('> .sidebar-item')
    const toggle = () => win.locator(toggleSel(parent))
    await row(parent).waitFor()
    const listing = () => callMcp(app, 'list', {})
    const focused = async (id) =>
      assert.ok(
        await until(async () => (await listing()).focusedSessionId === id),
        `focus must reach ${names[id] ?? id}`
      )
    const fold = async (id = parent, open = false) => {
      const sel = toggleSel(id)
      if ((await win.locator(sel).getAttribute('aria-expanded')) !== String(open)) {
        await win.locator(sel).click()
        await win.waitForTimeout(350)
      }
    }
    // A known starting point: the parent focused, its nest folded.
    await parentItem().click()
    await focused(parent)
    await fold()

    // ── 1. Nested at the open ──
    t.equal(
      'tabs an agent opened with attachToParent have no row on screen while the nest is folded',
      (await visibleRows(win, child)) + (await visibleRows(win, nested)),
      0
    )
    t.equal(
      'they are rows inside the parent’s nest, the grandchild included',
      (await win.locator(nestedRowSel(parent, child)).count()) +
        (await win.locator(nestedRowSel(parent, nested)).count()),
      2
    )
    t.equal(
      'a plain terminal opened with attachToParent is nested too',
      await win.locator(nestedRowSel(parent, page)).count(),
      1
    )
    t.equal('and has no row on screen while folded', await visibleRows(win, page), 0)
    t.equal('and its record names the tab it is under', recordOf(DIR, page)?.spawnedBy, parent)
    t.equal(
      'a terminal opened without attachToParent keeps its row',
      await row(terminal).count(),
      1
    )
    t.equal('the parent carries one toggle', await toggle().count(), 1)
    t.equal(
      'only a parent with nested tabs has a toggle',
      await win.locator('.sidebar-nest-toggle').count(),
      1
    )
    t.equal(
      'its count is the number of tabs under it, at any depth',
      (await toggleOf(win, parent))?.count,
      3
    )
    t.equal(
      'the toggle is a span inside the row, never a nested button',
      await win.locator('button button, .sidebar-item button.sidebar-nest-toggle').count(),
      0
    )

    // ── 2. The toggle unfolds and folds ──
    const orderFolded = await rowsOnScreen(win)
    await callMcp(app, 'focus', { sessionId: terminal })
    await focused(terminal)
    const parentSelectedBefore = await parentItem().getAttribute('data-selected')
    await toggle().click()
    await win.waitForTimeout(400)
    t.equal(
      'a click on the toggle unfolds the nest',
      await toggle().getAttribute('aria-expanded'),
      'true'
    )
    t.equal(
      'each nested tab is a row on screen',
      (await visibleRows(win, child)) +
        (await visibleRows(win, nested)) +
        (await visibleRows(win, page)),
      3
    )
    {
      const geo = await win.evaluate(
        ({ parentSel, ids, parentId }) => {
          const p = document.querySelector(parentSel)?.getBoundingClientRect()
          const sidebar = document
            .querySelector(parentSel)
            ?.closest('aside, nav, [class*="sidebar"]')
          const bound = (sidebar ?? document.body).getBoundingClientRect()
          return ids.map((id) => {
            const r = document
              .querySelector(
                `[data-sidebar-nested-root="${parentId}"][data-sidebar-item-id="${id}"] > .sidebar-item`
              )
              ?.getBoundingClientRect()
            const status = document.querySelector(
              `[data-sidebar-nested-root="${parentId}"][data-sidebar-item-id="${id}"] .sidebar-tab-status`
            )
            return {
              indented: !!r && !!p && r.left > p.left + 1,
              inside: !!r && r.right <= bound.right + 1 && r.left >= bound.left,
              status: !!status
            }
          })
        },
        {
          parentSel: `${ownRowSel(parent)} > .sidebar-item`,
          ids: [child, nested, page],
          parentId: parent
        }
      )
      t.check(
        'each nested row is indented right of the parent',
        geo.every((g) => g.indented),
        geo
      )
      t.check(
        'each nested row is inside the sidebar’s width',
        geo.every((g) => g.inside),
        geo
      )
      t.check(
        'each nested row has its own status slot',
        geo.every((g) => g.status),
        geo
      )
    }
    t.equal('the toggle never selects the parent row', (await listing()).focusedSessionId, terminal)
    t.equal(
      'and leaves the parent row’s selection as it was',
      await parentItem().getAttribute('data-selected'),
      parentSelectedBefore
    )
    await toggle().click()
    await win.waitForTimeout(400)
    t.equal('a second click folds it', await toggle().getAttribute('aria-expanded'), 'false')
    t.equal('folded, no nested row is on screen', await visibleRows(win, child), 0)
    // A press on the toggle and a move past the drag threshold: no drag.
    {
      const box = await toggle().boundingBox()
      await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await win.mouse.down()
      for (let i = 1; i <= 8; i++) {
        await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + i * 6)
        await win.waitForTimeout(25)
      }
      await win.waitForTimeout(250)
      const line = await activeLineBefore(win)
      const marked = await ontoMarked(win)
      await win.mouse.up()
      await win.waitForTimeout(400)
      t.check('a press on the toggle never starts a drag', line === null && marked.length === 0, {
        line,
        marked
      })
      eq('and the rows stay where they were', named(await rowsOnScreen(win)), named(orderFolded))
      await fold()
    }
    await toggle().focus()
    await win.keyboard.press('Enter')
    await win.waitForTimeout(350)
    t.equal(
      'Enter on the focused toggle unfolds',
      await toggle().getAttribute('aria-expanded'),
      'true'
    )
    await win.keyboard.press(' ')
    await win.waitForTimeout(350)
    t.equal(
      'Space on the focused toggle folds',
      await toggle().getAttribute('aria-expanded'),
      'false'
    )
    t.equal('the keys never selected the parent', (await listing()).focusedSessionId, terminal)

    // ── 3. The folded toggle's signal ──
    await parentItem().click()
    await focused(parent)
    await fold()
    const title = async (id, value, state) => {
      await win.evaluate(({ id, value }) => window.electronAPI.writeSession(id, value + '\n'), {
        id,
        value
      })
      assert.ok(
        await until(
          async () => (await listing()).sessions.find((s) => s.id === id)?.agentState === state
        ),
        `${names[id]} must reach ${state}`
      )
    }
    const checkSignal = async (status, token) => {
      let paint
      const settled = await until(
        async () => {
          paint = await toggle().evaluate(
            (el, { token }) => {
              const probe = document.createElement('span')
              probe.style.color = `var(${token})`
              el.appendChild(probe)
              const expected = getComputedStyle(probe).color
              probe.remove()
              const rect = el.getBoundingClientRect()
              return {
                status: el.getAttribute('data-status'),
                visible: !!rect.width && !!rect.height,
                actual: getComputedStyle(el).color,
                expected
              }
            },
            { status, token }
          )
          return paint.status === status && paint.visible && paint.actual === paint.expected
        },
        { tries: 20, gapMs: 50 }
      )
      t.check(
        `folded ${status} signal is visible and uses the status token’s colour`,
        settled,
        paint
      )
    }
    await win.mouse.move(900, 600)
    await title(nested, 'codex | Working', 'working')
    t.equal(
      'folded, a working nested tab shows on the toggle',
      await toggle().getAttribute('data-status'),
      'working'
    )
    await title(child, '[ ! ] Action Required | codex', 'blocked')
    t.equal(
      'folded, a tab waiting on you comes ahead of working',
      await toggle().getAttribute('data-status'),
      'needs-you'
    )
    t.check(
      'its label names the tab that waits',
      /Explorer: Waiting on you/.test((await toggle().getAttribute('aria-label')) ?? ''),
      await toggle().getAttribute('aria-label')
    )
    t.equal(
      'the parent’s own status slot is untouched',
      await row(parent).locator('> .sidebar-item .sidebar-tab-status').getAttribute('data-status'),
      'idle'
    )
    await checkSignal('needs-you', '--color-status-waiting')
    await title(child, 'codex | Ready', 'idle')
    t.equal('unread comes ahead of working', await toggle().getAttribute('data-status'), 'unread')
    await checkSignal('unread', '--color-status-working')
    // Reading the child clears its unread; the remaining work shows.
    await callMcp(app, 'focus', { sessionId: child })
    await focused(child)
    await parentItem().click()
    await focused(parent)
    await fold()
    t.equal(
      'reading the nested tab clears its unread, and the work under it shows',
      await toggle().getAttribute('data-status'),
      'working'
    )
    await title(nested, 'codex | Ready', 'idle')
    await callMcp(app, 'focus', { sessionId: nested })
    await focused(nested)
    await parentItem().click()
    await focused(parent)
    await fold()
    t.equal(
      'read and idle, the toggle signals nothing',
      await toggle().getAttribute('data-status'),
      'idle'
    )

    // ── 4. Selection and the digit shortcuts ──
    // Cycle with the next-tab shortcut until a nested tab is focused.
    let reached = null
    for (let i = 0; i < 8 && !reached; i++) {
      await win.keyboard.press('Meta+Shift+]')
      await win.waitForTimeout(300)
      const f = (await listing()).focusedSessionId
      if ([child, nested, page].includes(f)) reached = f
    }
    t.check('next-tab cycling reaches a nested tab', !!reached)
    if (reached) {
      t.equal(
        'cycling to a nested tab unfolds its nest',
        await toggle().getAttribute('aria-expanded'),
        'true'
      )
      t.equal(
        'and selects its row',
        await win
          .locator(`${nestedRowSel(parent, reached)} > .sidebar-item`)
          .getAttribute('data-selected'),
        'true'
      )
      t.equal(
        'with the nest unfolded the parent’s row is not marked selected',
        await parentItem().getAttribute('data-selected'),
        null
      )
      await toggle().click()
      await win.waitForTimeout(400)
      t.equal(
        'folded again, the parent’s row is marked selected',
        await parentItem().getAttribute('data-selected'),
        'true'
      )
      await win.keyboard.press('Meta+Shift+[')
      await win.waitForTimeout(300)
      t.check(
        'previous-tab cycling moves off the nested tab',
        (await listing()).focusedSessionId !== reached
      )
    }
    // Digits count the rows on screen.
    await parentItem().click()
    await focused(parent)
    await fold()
    {
      const onScreen = await rowsOnScreen(win)
      await win.keyboard.press('Meta+2')
      await win.waitForTimeout(300)
      t.equal(
        'folded: shortcut 2 selects the second row on screen',
        names[(await listing()).focusedSessionId],
        names[onScreen[1]]
      )
    }
    await parentItem().click()
    await focused(parent)
    await fold(parent, true)
    {
      const onScreen = await rowsOnScreen(win)
      const at = onScreen.indexOf(parent)
      t.check(
        'unfolded, the nested rows are drawn right after the parent',
        [child, nested, page].includes(onScreen[at + 1]),
        named(onScreen)
      )
      const digit = at + 2
      await win.keyboard.press(`Meta+${digit}`)
      await win.waitForTimeout(300)
      t.equal(
        `unfolded: shortcut ${digit} selects the first nested row, as drawn`,
        names[(await listing()).focusedSessionId],
        names[onScreen[at + 1]]
      )
      const last = onScreen.length
      if (last <= 9) {
        await win.keyboard.press(`Meta+${last}`)
        await win.waitForTimeout(300)
        t.equal(
          `unfolded: shortcut ${last} selects the last row on screen`,
          names[(await listing()).focusedSessionId],
          names[onScreen[last - 1]]
        )
      }
    }
    await parentItem().click()
    await focused(parent)
    await fold()

    // Range selection: from the parent to the terminal, the folded rows are not taken.
    await row(terminal)
      .locator('> .sidebar-item')
      .click({ modifiers: ['Shift'] })
    await win.waitForTimeout(300)
    {
      const onScreen = await rowsOnScreen(win)
      t.equal(
        'range selection covers the rows on screen between the two',
        await win
          .locator('.sidebar-item[data-selected="true"]:not([data-nest-collapsed="true"] *)')
          .count(),
        Math.abs(onScreen.indexOf(terminal) - onScreen.indexOf(parent)) + 1
      )
    }
    t.equal(
      'and none of the folded nested rows',
      await win
        .locator(`[data-sidebar-nested-root="${parent}"] > .sidebar-item[data-selected="true"]`)
        .count(),
      0
    )
    await parentItem().click()
    await focused(parent)

    // ── 5. Search ──
    for (const [query, id] of [
      ['Verifier', nested],
      ['Explorer', child]
    ]) {
      await win.fill('.group-switcher-search input', query)
      await win.waitForTimeout(500)
      t.equal(`search “${query}” shows the nested tab as a plain row`, await row(id).count(), 1)
      t.equal(`and on screen`, await visibleRows(win, id), 1)
      t.equal(`without a toggle`, await row(id).locator('.sidebar-nest-toggle').count(), 0)
    }
    await win.fill('.group-switcher-search input', '')
    await toggle().waitFor()
    t.equal('clearing the search folds it back under its parent', await visibleRows(win, nested), 0)

    // ── 6. Rename in place ──
    const ordinary = named(await rowsOnScreen(win))
    let parentName = 'Coordinator'
    for (const key of ['Enter', 'Escape']) {
      await parentItem().click({ button: 'right' })
      await win.getByRole('menuitem', { name: 'Rename', exact: true }).click()
      const editor = row(parent).locator('input')
      await editor.waitFor()
      await editor.fill(`Coordinator ${key}`)
      t.equal(
        `parent Rename ${key}: the nest stays folded while typing`,
        await visibleRows(win, child),
        0
      )
      eq(`parent Rename ${key}: the rows stay in order`, named(await rowsOnScreen(win)), ordinary)
      t.equal(
        `parent Rename ${key}: its toggle stays`,
        await row(parent).locator('.sidebar-nest-toggle').count(),
        1
      )
      await editor.press(key)
      if (key === 'Enter') parentName = `Coordinator ${key}`
      const done = await until(
        async () => (await listing()).sessions.find((s) => s.id === parent)?.name === parentName
      )
      t.check(`parent Rename ${key} ${key === 'Enter' ? 'commits' : 'cancels'} the edit`, !!done)
    }
    await callMcp(app, 'rename', { target: 'session', id: parent, name: 'Coordinator' })
    await until(
      async () => (await listing()).sessions.find((s) => s.id === parent)?.name === 'Coordinator'
    )
    await fold(parent, true)
    for (const key of ['Enter', 'Escape']) {
      const before = named(await rowsOnScreen(win))
      const nestedItem = win.locator(`${nestedRowSel(parent, child)} > .sidebar-item`)
      await nestedItem.click({ button: 'right' })
      await win.getByRole('menuitem', { name: 'Rename', exact: true }).click()
      const editor = win.locator(`${nestedRowSel(parent, child)} input`)
      await editor.waitFor()
      await editor.fill(`Explorer ${key}`)
      t.check(
        `nested Rename ${key}: the editor has the focus`,
        await editor.evaluate((e) => e === document.activeElement)
      )
      eq(
        `nested Rename ${key}: the nested row stays where it is`,
        named(await rowsOnScreen(win)),
        before
      )
      t.equal(
        `nested Rename ${key}: one editor`,
        await win.locator('[data-sidebar-item-id] input').count(),
        1
      )
      await editor.press(key)
      const want = key === 'Enter' ? `Explorer ${key}` : 'Explorer Enter'
      const done = await until(
        async () => (await listing()).sessions.find((s) => s.id === child)?.name === want
      )
      t.check(`nested Rename ${key} ${key === 'Enter' ? 'commits' : 'cancels'} the edit`, !!done)
      eq(`nested Rename ${key}: the rows are as before`, named(await rowsOnScreen(win)), before)
    }
    await callMcp(app, 'rename', { target: 'session', id: child, name: 'Explorer' })
    await until(
      async () => (await listing()).sessions.find((s) => s.id === child)?.name === 'Explorer'
    )
    // The keyboard's menu key on a nested row opens the row's own menu. The
    // pop-up menu this replaced opened a nested tab's management menu on
    // Shift+F10 (and the ContextMenu key), the keyboard's only road to it;
    // a nested row is a row, and must keep that road (where Attach to and
    // Detach from now live).
    await win.locator(`${nestedRowSel(parent, child)} > .sidebar-item`).focus()
    await win.keyboard.press('Shift+F10')
    t.equal(
      'the keyboard opens a nested row’s menu',
      await win.getByRole('menuitem', { name: 'Copy session ID', exact: true }).count(),
      1
    )
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)

    // ── 7. The menu: Attach to, Detach from ──
    const submenuOf = async (id, nestedUnder) => {
      const item = nestedUnder
        ? win.locator(`${nestedRowSel(nestedUnder, id)} > .sidebar-item`)
        : row(id).locator('> .sidebar-item')
      await item.click({ button: 'right' })
      const menu = win.getByRole('menu').first()
      await menu.waitFor()
      const entries = await menu.getByRole('menuitem').allInnerTexts()
      return entries.map((e) => e.trim())
    }
    const attachEntries = async () => {
      const sub = win.getByRole('menuitem', { name: 'Attach to' })
      if ((await sub.count()) === 0) return null
      await sub.hover()
      await win.keyboard.press('ArrowRight')
      await until(async () => ((await win.getByRole('menu').count()) >= 2 ? true : null))
      return (await win.getByRole('menu').nth(1).getByRole('menuitem').allInnerTexts()).map((e) =>
        e.trim()
      )
    }
    // The parent: never itself, never a tab nested under it.
    {
      await submenuOf(parent)
      const offered = await attachEntries()
      t.check('the parent’s menu offers Attach to', Array.isArray(offered), offered)
      t.check(
        'Attach to never lists the tab itself nor a tab nested under it',
        Array.isArray(offered) &&
          !offered.some((n) => ['Coordinator', 'Explorer', 'Verifier', 'Page server'].includes(n)),
        offered
      )
      t.check('and lists the terminal it may go under', offered?.includes('Dev terminal'), offered)
      await win.keyboard.press('Escape')
      await win.keyboard.press('Escape')
      await win.waitForTimeout(300)
    }
    // The terminal, attached to the parent from its menu.
    {
      await submenuOf(terminal)
      const offered = await attachEntries()
      t.check('the terminal is offered the parent', offered?.includes('Coordinator'), offered)
      t.check('and not itself', !offered?.includes('Dev terminal'), offered)
      if (offered?.includes('Coordinator')) {
        await win
          .getByRole('menu')
          .nth(1)
          .getByRole('menuitem', { name: 'Coordinator', exact: true })
          .click()
      } else {
        await win.keyboard.press('Escape')
      }
      const nestedThen = await until(async () =>
        (await listing()).sessions.find((s) => s.id === terminal)?.nestedUnder === parent
          ? true
          : null
      )
      t.check('a click on an entry nests the tab', !!nestedThen)
      t.equal('the count says so', (await toggleOf(win, parent))?.count, 4)
    }
    // Detach from “Coordinator”, on the nested row.
    {
      await fold(parent, true)
      const entries = await submenuOf(terminal, parent)
      t.check(
        'a nested row’s menu offers Detach from “Coordinator”',
        entries.includes('Detach from “Coordinator”'),
        entries
      )
      t.check('and no Attach to', !entries.includes('Attach to'), entries)
      await win.getByRole('menuitem', { name: 'Detach from “Coordinator”', exact: true }).click()
      const out = await until(async () =>
        (await listing()).sessions.find((s) => s.id === terminal)?.nestedUnder === null
          ? true
          : null
      )
      t.check('Detach takes it out', !!out)
      await win.waitForTimeout(400)
      const onScreen = await rowsOnScreen(win)
      const lastOfParent = Math.max(
        ...[parent, child, nested, page].map((id) => onScreen.indexOf(id))
      )
      t.equal('it is an ordinary row again', await row(terminal).count(), 1)
      t.equal(
        'right after its former parent (and the tabs under it)',
        onScreen.indexOf(terminal),
        lastOfParent + 1
      )
      t.equal('the count is back to 3', (await toggleOf(win, parent))?.count, 3)
    }

    // ── 8. Geometry, in the four themes ──
    await callMcp(app, 'rename', {
      target: 'session',
      id: parent,
      name: 'Coordinator of the invoice export lane and its verifiers, round two'
    })
    await win.waitForTimeout(500)
    await fold(parent, true)
    for (const theme of ['dark', 'light', 'coffee', 'charcoal']) {
      await win.evaluate((theme) => window.electronAPI.skinsActivate(theme), theme)
      await win.waitForTimeout(400)
      const geo = await win.evaluate(
        ({ parentSel, nestedSel, plainSel }) => {
          const item = document.querySelector(parentSel)
          const r = item.getBoundingClientRect()
          const toggle = item.querySelector('.sidebar-nest-toggle').getBoundingClientRect()
          const name = item
            .querySelector('[data-testid="session-tab-name"]')
            .getBoundingClientRect()
          const nestedH = [...document.querySelectorAll(nestedSel)].map(
            (el) => el.getBoundingClientRect().height
          )
          const plainH = document.querySelector(plainSel).getBoundingClientRect().height
          return {
            inside:
              toggle.left >= r.left - 0.5 &&
              toggle.right <= r.right + 0.5 &&
              toggle.top >= r.top - 0.5 &&
              toggle.bottom <= r.bottom + 0.5,
            nameShare: name.width / r.width,
            nestedH,
            plainH
          }
        },
        {
          parentSel: `${ownRowSel(parent)} > .sidebar-item`,
          nestedSel: `[data-sidebar-nested-root="${parent}"] > .sidebar-item`,
          plainSel: `${ownRowSel(terminal)} > .sidebar-item`
        }
      )
      t.check(`${theme}: the toggle is inside its row`, geo.inside, geo)
      t.check(
        `${theme}: with a long name the parent’s name keeps at least 60% of the row`,
        geo.nameShare >= 0.6,
        geo
      )
      t.check(
        `${theme}: nested rows have the height of an ordinary row`,
        geo.nestedH.length === 3 && geo.nestedH.every((h) => Math.abs(h - geo.plainH) <= 1),
        geo
      )
    }
    await callMcp(app, 'rename', { target: 'session', id: parent, name: 'Coordinator' })

    // ── 9. Leads and successors opt out ──
    for (const [name, attachToParent] of [
      ['Lane lead', false],
      ['Successor', undefined]
    ]) {
      const id = await openTab(app, ROOT, name, { caller: parent, attachToParent })
      await row(id).waitFor()
      t.equal(`${name}: a row of its own`, await row(id).count(), 1)
      const records = await win.evaluate(() => window.electronAPI.sessionsList())
      t.equal(`${name}: no spawnedBy`, records.find((s) => s.id === id)?.spawnedBy, undefined)
      const read = await callMcp(app, 'readSession', { sessionId: 'parent', callerSessionId: id })
      t.equal(`${name}: its "parent" is still the tab that opened it`, read?.sessionId, parent)
      await callMcp(app, 'closeSession', { sessionId: id })
    }

    // Every tab stays available to the tools and to the session host.
    {
      const all = await listing()
      t.equal(
        'the tools still list every tab',
        [parent, child, nested, page, terminal].every((id) =>
          all.sessions.some((s) => s.id === id)
        ),
        true
      )
      const kernel = await win.evaluate(() => window.electronAPI.sessionsList())
      t.equal(
        'the session host keeps every tab',
        [parent, child, nested, page, terminal].every((id) => kernel.some((s) => s.id === id)),
        true
      )
    }

    // ── 10. A nested tab in another group ──
    await fold()
    const workers = await callMcp(app, 'createGroup', { name: 'Workers' })
    await callMcp(app, 'moveSession', { sessionId: child, groupId: workers.groupId })
    await win.waitForTimeout(700)
    t.equal(
      'a nested tab moved into another group keeps no row of its own',
      await row(child).count(),
      0
    )
    t.equal(
      'it stays in its parent’s nest while the parent is reachable',
      await win.locator(nestedRowSel(parent, child)).count(),
      1
    )
    const placeholder = win.locator(`[data-sidebar-empty-group="${workers.groupId}"]`)
    t.equal(
      'the group left with only nested tabs says where they are shown',
      (await placeholder.innerText().catch(() => null))?.trim(),
      'Subagents shown with their parent'
    )
    t.equal(
      'and keeps its new-session control',
      await win.getByRole('button', { name: 'New session in Workers', exact: true }).count(),
      1
    )
    t.equal(
      'and its terminal controls',
      await win.getByRole('button', { name: 'Terminals of Workers', exact: true }).count(),
      1
    )
    await win
      .locator('.group-switcher-chips .group-switcher-chip')
      .filter({ hasText: 'Workers' })
      .click()
    await row(child)
      .waitFor({ timeout: 5000 })
      .catch(() => {})
    t.equal('filtering the parent out gives the nested tab its row', await row(child).count(), 1)
    await win.keyboard.press('Meta+1')
    await win.waitForTimeout(300)
    t.equal(
      'the digit shortcuts follow the filter that shows it',
      names[(await listing()).focusedSessionId],
      'Explorer'
    )
    await win.locator('.group-switcher-head .group-switcher-chip').click()
    await toggle().waitFor()
    await win.waitForTimeout(400)
    t.equal('All folds it back under its parent', await row(child).count(), 0)
    const coordination = await callMcp(app, 'createGroup', { name: 'Coordination' })
    await callMcp(app, 'moveSession', { sessionId: parent, groupId: coordination.groupId })
    await win.waitForTimeout(600)
    const header = win.locator(rowSel(coordination.groupId))
    await header.locator('.sidebar-tab-icon').first().click()
    await row(child)
      .waitFor({ timeout: 5000 })
      .catch(() => {})
    t.equal(
      'a collapsed parent in another group leaves the nested tab a row of its own',
      await row(child).count(),
      1
    )
    await header.locator('.sidebar-tab-icon').first().click()
    await toggle().waitFor()
    await win.waitForTimeout(400)
    t.equal('expanding the parent nests it again', await row(child).count(), 0)

    // ── 11. Close ──
    await callMcp(app, 'closeSession', { sessionId: page })
    const lowered = await until(async () =>
      (await toggleOf(win, parent))?.count === 2 ? true : null
    )
    t.check('closing a nested row lowers the count', !!lowered, await toggleOf(win, parent))
    await callMcp(app, 'closeSession', { sessionId: parent })
    await row(child).waitFor()
    t.equal(
      'closing the parent leaves its nested tab a row of its own',
      await row(child).count(),
      1
    )
    t.equal(
      'the grandchild stays nested under the surviving tab',
      await win.locator(nestedRowSel(child, nested)).count(),
      1
    )
    t.equal('which counts it', (await toggleOf(win, child))?.count, 1)
    t.check(
      'one nested tab: the label is singular',
      /^1 tab nested under Explorer/.test((await toggleOf(win, child))?.label ?? ''),
      await toggleOf(win, child)
    )
    await callMcp(app, 'closeSession', { sessionId: nested })
    const gone = await until(async () => ((await toggleOf(win, child)) === null ? true : null))
    t.check('closing the last nested tab removes the toggle', !!gone)
    t.equal('no toggle is left anywhere', await win.locator('.sidebar-nest-toggle').count(), 0)
  } finally {
    await app.close()
  }
}
