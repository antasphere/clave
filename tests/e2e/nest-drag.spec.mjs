/**
 * A tab is nested by a real pointer drag in the sidebar, and taken out the
 * same way (PRDCT-4997, PRDCT-4998).
 *
 * On a row that can take the dragged tab, the top 30% means "before it", the
 * bottom 30% "after it", and the middle "under it": the row is outlined
 * (`data-drop-onto`) and no line is drawn. A row whose own nest is unfolded
 * has no "after" zone. A nested row dropped between two ordinary rows is
 * taken out there; dropped on another tab's middle, it moves under that tab
 * in one drop. Whatever a drop nests is written on the tab's record
 * (`spawnedBy`), listed by `clave_list` (`nestedUnder`), placed right after
 * the parent in the window's saved layout, and kept across a restart. The
 * sidebar's Undo puts back the link its step changed.
 *
 * Fails if: a drop on a row's middle reorders instead of nesting (or its
 * edges nest instead of reordering), a drop writes nothing on the record, a
 * nested row cannot be dragged out or onto another tab, a parent dragged
 * into a group leaves its nested tabs behind, a drop that means nothing (a
 * tab over its own nested rows, a nested row over its siblings or its parent)
 * marks a row or writes, a stopped tab cannot be nested, Undo does not undo
 * a nest or a detach, or a restart loses a nesting or brings back one that
 * was taken out.
 *
 * The agents are a recording stand-in `codex` on PATH (nest-helpers.mjs): no
 * provider, no account, no network.
 */
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
  toggleOf,
  visibleRows,
  rowsOnScreen,
  ontoMarked,
  activeLineBefore,
  dropLines,
  centerOf,
  dragTo,
  hoverTo,
  release,
  cancelDrag,
  recordOf,
  layoutOf,
  flatOrder,
  nestedUnderAll,
  nestBy,
  setNestOpen
} from './nest-helpers.mjs'

const DIR = userDataDir('nest-drag')
const ROOT = fixturePath('nest-drag-root')
const WS = {
  id: 'nest-drag',
  name: 'Nest drag',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

/** A point at `frac` of a row's height (the tab's own row by default). */
const at = (win, sel, frac) => () => centerOf(win, sel, { yFraction: frac })

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
  let { app, win } = await launchApp(DIR, { server: 'in-process', env })
  // The ids, named after what they stand for (invented names).
  let lead, notes, ledger, scratch, round1, round2
  try {
    lead = await openTab(app, ROOT, 'Lane · Invoice export')
    notes = await openTab(app, ROOT, 'Release notes')
    ledger = await openTab(app, ROOT, 'Lane · Ledger connector')
    scratch = await openTab(app, ROOT, 'Scratch terminal', { mode: 'terminal' })
    round1 = await openTab(app, ROOT, 'Verifier · round 1')
    round2 = await openTab(app, ROOT, 'Verifier · round 2')
    const all = [lead, notes, ledger, scratch, round1, round2]
    await win.locator(ownRowSel(round2)).waitFor()
    await win.waitForTimeout(800)
    const names = {
      [lead]: 'lead',
      [notes]: 'notes',
      [ledger]: 'ledger',
      [scratch]: 'scratch',
      [round1]: 'round1',
      [round2]: 'round2'
    }
    const named = (ids) => ids.map((id) => names[id] ?? id)
    const start = await rowsOnScreen(win)
    eq('six tabs, six rows', start.length, 6, named(start))

    const layoutNow = async () => flatOrder(await layoutOf(DIR, win))
    /** Poll the saved layout until `fn(order)` holds; answers the last order. */
    const layoutUntil = async (fn) => {
      let last = []
      const ok = await until(async () => {
        last = await layoutNow()
        return fn(last) ? true : null
      })
      return { ok: ok === true, order: named(last) }
    }
    const recordUntil = async (id, fn) => {
      let last = null
      const ok = await until(() => {
        last = recordOf(DIR, id)
        return last && fn(last) ? true : null
      })
      return { ok: ok === true, spawnedBy: last?.spawnedBy ?? '(no record)' }
    }
    const after = (order, parent, id) => order.indexOf(id) === order.indexOf(parent) + 1
    const nestedNow = async () => {
      const m = await nestedUnderAll(app)
      return Object.fromEntries(
        Object.entries(m).map(([k, v]) => [names[k] ?? k, v && (names[v] ?? v)])
      )
    }

    // ── 1. The three zones of a row, held ──
    // Release notes, dragged over the ledger lane's row.
    const fromNotes = await centerOf(win, ownRowSel(notes))
    await dragTo(win, fromNotes, at(win, ownRowSel(ledger), 0.5))
    eq('held over the middle of a row: that row is marked', await ontoMarked(win), [ledger])
    eq('and no drop line exists', await dropLines(win), 0)
    await hoverTo(win, at(win, ownRowSel(ledger), 0.08))
    eq('held over its top 15%: no row is marked', await ontoMarked(win), [])
    eq('and the line is above it', await activeLineBefore(win), ledger)
    await hoverTo(win, at(win, ownRowSel(ledger), 0.92))
    eq('held over its bottom 15%: no row is marked', await ontoMarked(win), [])
    {
      const order = await rowsOnScreen(win)
      const next = order[order.indexOf(ledger) + 1] ?? 'end'
      eq('and the line is under it', await activeLineBefore(win), next, named(order))
    }
    await cancelDrag(win)

    // ── 2. Released at the top and at the bottom: a plain move ──
    await dragTo(win, await centerOf(win, ownRowSel(notes)), at(win, ownRowSel(ledger), 0.08))
    await release(win)
    {
      const order = await rowsOnScreen(win)
      t.check(
        'released at the top 15%: the tab moved right above the row',
        order.indexOf(notes) === order.indexOf(ledger) - 1,
        named(order)
      )
      const nested = await nestedNow()
      t.check(
        'and nothing is nested',
        Object.values(nested).every((v) => v === null),
        nested
      )
    }
    await dragTo(win, await centerOf(win, ownRowSel(notes)), at(win, ownRowSel(ledger), 0.92))
    await release(win)
    {
      const order = await rowsOnScreen(win)
      t.check(
        'released at the bottom 15%: the tab moved right under the row',
        order.indexOf(notes) === order.indexOf(ledger) + 1,
        named(order)
      )
      const nested = await nestedNow()
      t.check(
        'and nothing is nested',
        Object.values(nested).every((v) => v === null),
        nested
      )
    }

    // ── 3. Released on the middle: nested ──
    await dragTo(win, await centerOf(win, ownRowSel(notes)), at(win, ownRowSel(ledger), 0.5))
    await release(win)
    {
      const nested = await until(async () =>
        (await nestedUnderAll(app))[notes] === ledger ? true : null
      )
      t.check(
        'released on the middle: clave_list says nestedUnder',
        nested === true,
        await nestedNow()
      )
      const rec = await recordUntil(notes, (r) => r.spawnedBy === ledger)
      t.check('the record on disk has spawnedBy', rec.ok, rec)
      const lay = await layoutUntil((o) => after(o, ledger, notes))
      t.check('the saved layout holds the tab right after its parent', lay.ok, lay.order)
      const toggle = await toggleOf(win, ledger)
      eq("the parent's count is 1", toggle?.count, 1, toggle)
      eq('its nest is unfolded', toggle?.expanded, 'true', toggle)
      eq('and shows the row', await visibleRows(win, notes), 1)
      eq(
        'the row shown is inside the parent’s nest',
        await win.locator(nestedRowSel(ledger, notes)).count(),
        1
      )
      eq('no ordinary row is left for it', await win.locator(ownRowSel(notes)).count(), 0)
    }

    // ── 4. A plain terminal dragged onto a tab is nested ──
    await dragTo(win, await centerOf(win, ownRowSel(scratch)), at(win, ownRowSel(lead), 0.5))
    eq('a plain terminal held on a tab marks it', await ontoMarked(win), [lead])
    await release(win)
    {
      const ok = await until(async () =>
        (await nestedUnderAll(app))[scratch] === lead ? true : null
      )
      t.check('a plain terminal dragged onto a tab is nested', ok === true, await nestedNow())
      const rec = await recordUntil(scratch, (r) => r.spawnedBy === lead)
      t.check('and its record has spawnedBy', rec.ok, rec)
    }

    // ── 5. A nested row dragged between two ordinary rows: taken out there ──
    // The two ordinary rows: the two verifiers, wherever they are drawn.
    {
      const order = await rowsOnScreen(win)
      const [upper, lower] = [round1, round2].sort((a, b) => order.indexOf(a) - order.indexOf(b))
      const adjacent = order.indexOf(lower) === order.indexOf(upper) + 1
      t.check('the two verifiers are adjacent rows', adjacent, named(order))
      await dragTo(
        win,
        await centerOf(win, nestedRowSel(ledger, notes)),
        at(win, ownRowSel(lower), 0.08)
      )
      eq('a nested row held between two rows shows the line', await activeLineBefore(win), lower)
      await release(win)
      const out = await until(async () =>
        (await nestedUnderAll(app))[notes] === null ? true : null
      )
      t.check(
        'dropped between two ordinary rows: taken out (nestedUnder null)',
        out === true,
        await nestedNow()
      )
      const rec = await recordUntil(notes, (r) => !r.spawnedBy)
      t.check('and the record has no spawnedBy', rec.ok, rec)
      const lay = await layoutUntil(
        (o) =>
          o.indexOf(notes) === o.indexOf(lower) - 1 && o.indexOf(upper) === o.indexOf(notes) - 1
      )
      t.check('at that place in the layout', lay.ok, lay.order)
      eq('and it is an ordinary row again', await win.locator(ownRowSel(notes)).count(), 1)
      eq('the parent it left has no toggle', await toggleOf(win, ledger), null)
    }

    // ── 6. A nested row dragged onto ANOTHER tab's middle: nested there in one drop ──
    // The scratch terminal is nested under the invoice lead; its nest is open
    // (the drop unfolded it).
    eq("the invoice lead's nest is open", (await toggleOf(win, lead))?.expanded, 'true')
    await dragTo(
      win,
      await centerOf(win, nestedRowSel(lead, scratch)),
      at(win, ownRowSel(ledger), 0.5)
    )
    eq('a nested row held on another tab marks that tab', await ontoMarked(win), [ledger])
    await release(win)
    {
      const ok = await until(async () =>
        (await nestedUnderAll(app))[scratch] === ledger ? true : null
      )
      t.check('dropped onto another tab: nested under that one', ok === true, await nestedNow())
      const rec = await recordUntil(scratch, (r) => r.spawnedBy === ledger)
      t.check('its record names the new parent', rec.ok, rec)
      eq('the first parent has no toggle any more', await toggleOf(win, lead), null)
      eq('the new parent counts it', (await toggleOf(win, ledger))?.count, 1)
    }

    // ── 7. A stopped tab nests ──
    await win.evaluate((id) => window.electronAPI.writeSession(id, 'quit\n'), round1)
    const stopped = await until(async () => {
      const l = await callMcp(app, 'list', {})
      const s = l.sessions.find((x) => x.id === round1)
      return s && s.alive === false ? s : null
    })
    t.check(
      'the first verifier is stopped, its row kept',
      !!stopped && (await win.locator(ownRowSel(round1)).count()) === 1,
      stopped
    )
    await dragTo(win, await centerOf(win, ownRowSel(round1)), at(win, ownRowSel(round2), 0.5))
    eq('a stopped tab held on a tab marks it', await ontoMarked(win), [round2])
    await release(win)
    {
      const ok = await until(async () =>
        (await nestedUnderAll(app))[round1] === round2 ? true : null
      )
      t.check('a stopped tab dropped on a tab is nested under it', ok === true, await nestedNow())
      const rec = await recordUntil(round1, (r) => r.spawnedBy === round2)
      t.check("and the stopped tab's record has spawnedBy", rec.ok, rec)
      eq('the parent counts it', (await toggleOf(win, round2))?.count, 1)
    }

    // ── 8. A parent dragged into a group takes its nested tabs with it ──
    const { groupId } = await callMcp(app, 'createGroup', { name: 'Billing' })
    await win.locator(rowSel(groupId)).waitFor()
    await win.waitForTimeout(500)
    await dragTo(win, await centerOf(win, ownRowSel(ledger)), at(win, rowSel(groupId), 0.75))
    await release(win)
    {
      const l = await until(async () => {
        const list = await callMcp(app, 'list', {})
        const g = list.groups.find((x) => x.id === groupId)
        return g?.sessionIds?.includes(ledger) ? g : null
      })
      t.check('the parent is in the group', !!l, l)
      eq(
        "the group's sessionIds hold its nested tab right after it",
        l?.sessionIds?.join(','),
        [ledger, scratch].join(',')
      )
      const nested = await nestedUnderAll(app)
      eq('and the nested tab stays nested', nested[scratch], ledger)
    }

    // ── 9. Drops that mean nothing ──
    // Two siblings under the ledger lane, its nest open: the scratch terminal
    // and the release notes, nested through the store as the menu does.
    eq('nesting through the store answers ok', await nestBy(win, notes, ledger), { ok: true })
    await setNestOpen(win, ledger, true)
    await win.waitForTimeout(500)
    const frozen = { nested: await nestedNow(), layout: await layoutNow() }
    // The parent over its own nested rows (and a parent under one of its own
    // nested tabs): nothing marked, no line.
    for (const child of [scratch, notes]) {
      await dragTo(
        win,
        await centerOf(win, ownRowSel(ledger)),
        at(win, nestedRowSel(ledger, child), 0.5)
      )
      eq(
        `the parent over its nested row ${names[child]}: no row is marked`,
        await ontoMarked(win),
        []
      )
      eq(
        `the parent over its nested row ${names[child]}: no line`,
        await activeLineBefore(win),
        null
      )
      await release(win)
    }
    // A nested row over its sibling and over its own parent.
    await dragTo(
      win,
      await centerOf(win, nestedRowSel(ledger, scratch)),
      at(win, nestedRowSel(ledger, notes), 0.5)
    )
    eq('a nested row over its sibling: no row is marked', await ontoMarked(win), [])
    eq('a nested row over its sibling: no line', await activeLineBefore(win), null)
    await release(win)
    for (const frac of [0.5, 0.75]) {
      await dragTo(
        win,
        await centerOf(win, nestedRowSel(ledger, scratch)),
        at(win, ownRowSel(ledger), frac)
      )
      eq(
        `a nested row over its own parent (at ${frac}): no row is marked`,
        await ontoMarked(win),
        []
      )
      eq(
        `a nested row over its own parent (at ${frac}): no line`,
        await activeLineBefore(win),
        null
      )
      await release(win)
    }
    // The parent's top edge is the line above it, between two rows: a place
    // to take the tab out to (section 5), so it is offered there; not dropped.
    await dragTo(
      win,
      await centerOf(win, nestedRowSel(ledger, scratch)),
      at(win, ownRowSel(ledger), 0.1)
    )
    eq(
      'over its parent’s top edge, the line above the parent is offered',
      await activeLineBefore(win),
      ledger
    )
    await cancelDrag(win)
    await win.waitForTimeout(500)
    eq('and nothing was nested or taken out', await nestedNow(), frozen.nested)
    eq('and the layout is unchanged', await layoutNow(), frozen.layout)

    // ── 10. A row with an unfolded nest has no "after" zone ──
    await dragTo(win, await centerOf(win, ownRowSel(lead)), at(win, ownRowSel(ledger), 0.9))
    eq(
      'held over the bottom 15% of a row with an open nest: the row is marked',
      await ontoMarked(win),
      [ledger]
    )
    eq('and no line is drawn under it', await dropLines(win), 0)
    await cancelDrag(win)

    // ── 11. Undo ──
    // Undo right after a nest: the tab is a row of its own again where it was.
    const beforeNest = await rowsOnScreen(win)
    await dragTo(win, await centerOf(win, ownRowSel(lead)), at(win, ownRowSel(round2), 0.5))
    await release(win)
    const nestedLead = await until(async () =>
      (await nestedUnderAll(app))[lead] === round2 ? true : null
    )
    t.check('the lead is nested under the second verifier', nestedLead === true, await nestedNow())
    await win.locator(`${ownRowSel(round2)} > .sidebar-item`).focus()
    await win.keyboard.press('Meta+z')
    {
      const out = await until(async () =>
        (await nestedUnderAll(app))[lead] === null ? true : null
      )
      t.check(
        'Undo right after a nest: the tab is a row of its own again',
        out === true,
        await nestedNow()
      )
      const rec = await recordUntil(lead, (r) => !r.spawnedBy)
      t.check('and its record has no spawnedBy', rec.ok, rec)
      eq('where it was', named(await rowsOnScreen(win)), named(beforeNest))
    }
    // Undo right after a detach: nested again.
    const scratchRow = nestedRowSel(ledger, scratch)
    // Out to the line above the invoice lead, an ordinary row of its own.
    await dragTo(win, await centerOf(win, scratchRow), at(win, ownRowSel(lead), 0.08))
    await release(win)
    const detached = await until(async () =>
      (await nestedUnderAll(app))[scratch] === null ? true : null
    )
    t.check('the scratch terminal was taken out by a drag', detached === true, await nestedNow())
    await win.locator(`${ownRowSel(lead)} > .sidebar-item`).focus()
    await win.keyboard.press('Meta+z')
    {
      const back = await until(async () =>
        (await nestedUnderAll(app))[scratch] === ledger ? true : null
      )
      t.check('Undo right after a detach: nested again', back === true, await nestedNow())
      const rec = await recordUntil(scratch, (r) => r.spawnedBy === ledger)
      t.check('and its record has spawnedBy again', rec.ok, rec)
    }

    // ── 12. Restart ──
    // Before it, take the release notes out (by the store, as the menu does).
    await store_detach(win, notes)
    const outBefore = await until(async () =>
      (await nestedUnderAll(app))[notes] === null ? true : null
    )
    t.check('the release notes were taken out before the restart', outBefore === true)
    await until(() => (!recordOf(DIR, notes)?.spawnedBy ? true : null))
    await win.waitForTimeout(1500)
    await app.close()
    ;({ app, win } = await launchApp(DIR, { server: 'in-process', env }))
    // The stopped verifier's record is offered by the restore prompt: Restore
    // starts it again from its record, which keeps its nesting.
    const restore = win.getByRole('button', { name: 'Restore', exact: true })
    const prompted = await until(() => restore.isVisible().catch(() => false), { tries: 60 })
    t.check('the stopped tab is offered by the restore prompt', !!prompted)
    if (prompted) await restore.click()
    await win.locator(ownRowSel(ledger)).waitFor({ timeout: 20_000 })
    await win.waitForTimeout(1500)
    {
      const nested = await until(async () => {
        const m = await nestedUnderAll(app)
        return m[scratch] === ledger && m[round1] === round2 ? m : null
      })
      t.check('after a restart the nested tabs are nested', !!nested, await nestedNow())
      const tl = await toggleOf(win, ledger)
      const tr = await toggleOf(win, round2)
      eq('the ledger lane counts its nested tab', tl?.count, 1, tl)
      eq('the second verifier counts its stopped tab', tr?.count, 1, tr)
      // Which tab a restart puts on screen is the app's own business (the
      // first one it places, in the order they come back). The nests come
      // back folded, but for the one that holds that tab: the focused tab is
      // always in sight, whether it or its parent came back first.
      const onScreen = (await callMcp(app, 'list', {})).focusedSessionId
      const holder = { [scratch]: ledger, [round1]: round2 }[onScreen] ?? null
      const folds = async () => ({
        ledger: (await toggleOf(win, ledger))?.expanded,
        round2: (await toggleOf(win, round2))?.expanded
      })
      const expected = { ledger: String(holder === ledger), round2: String(holder === round2) }
      await until(async () =>
        JSON.stringify(await folds()) === JSON.stringify(expected) ? true : null
      )
      eq(
        'the nests come back folded, but for the one that holds the tab on screen',
        await folds(),
        expected,
        { onScreen: names[onScreen] ?? onScreen, got: await folds(), expected }
      )
      // Folded by the person, a nest stays folded, the tab on screen in it or not.
      await setNestOpen(win, ledger, false)
      await setNestOpen(win, round2, false)
      await win.waitForTimeout(500)
      eq(
        'a folded nest shows no row',
        (await visibleRows(win, scratch)) + (await visibleRows(win, round1)),
        0
      )
      await win.locator(`${rowSel(ledger)} > .sidebar-item .sidebar-nest-toggle`).click()
      await win.waitForTimeout(500)
      eq('unfolding shows it', await visibleRows(win, scratch), 1)
      eq(
        'a tab taken out before the restart is still out',
        (await nestedUnderAll(app))[notes],
        null
      )
      eq('and has its own row', await win.locator(ownRowSel(notes)).count(), 1)
      void all
    }
  } finally {
    await app.close()
  }
}

/** Take a tab out through the store's action, as the row's menu does. */
function store_detach(win, id) {
  return win.evaluate((sid) => window.__claveSessionStoreForTests.getState().detachSession(sid), id)
}
