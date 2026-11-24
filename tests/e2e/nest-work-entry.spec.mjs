/**
 * A wave or lane entry takes no dropped tab, and is not nested itself
 * (PRDCT-4997).
 *
 * A tab that works on a wave or a lane is drawn by its unit's entry, one row
 * for the whole unit, with no nest of its own to unfold: a tab nested under
 * it would leave the list with nothing shown. So a tab held over the middle
 * of an entry's row marks no row, and a release there nests nothing. The
 * other way round, the entry held over the middle of a tab marks nothing
 * either: a tab that works on a lane is not nested, by the rule both the
 * window and the server apply. An ordinary tab held over the middle of
 * another ordinary tab is marked, in the same drag, so the two checks above
 * are not passing on a pointer that never reached a row's middle.
 *
 * Fails if: the middle of an entry's row is offered as a place to nest, a
 * release there writes a link, or an entry can be dragged under a tab.
 *
 * The agents are a recording stand-in `codex` on PATH (nest-helpers.mjs): no
 * provider, no account, no network. The lane is given through an agent tab's
 * own token, on the road real agents take.
 */
import { mkdirSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  until,
  mcpEndpoint,
  serverDataDirOf,
  spawnAgentTabIn,
  toolErrored
} from './harness.mjs'
import {
  writeRecordingCli,
  openTab,
  rowSel,
  ownRowSel,
  ontoMarked,
  dropLines,
  centerOf,
  dragTo,
  hoverTo,
  release,
  cancelDrag,
  recordOf,
  mcpClient,
  errorText,
  nestedUnderAll
} from './nest-helpers.mjs'

const DIR = userDataDir('nest-work-entry')
const ROOT = fixturePath('nest-work-entry-root')
const WS = {
  id: 'nest-work-entry',
  name: 'Nest work entry',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

export async function run(t) {
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
    const agent = await spawnAgentTabIn(app, win, serverDataDirOf(DIR))
    t.check('an agent tab holds its MCP token', !!agent?.token, agent)
    const client = mcpClient(mcpEndpoint(DIR), agent.token)
    await client.init()
    // Invented names. The notes and the scratch tab are ordinary tabs; the
    // ledger tab leads a lane and is drawn by the lane's entry.
    const notes = await openTab(app, ROOT, 'Release notes')
    const scratch = await openTab(app, ROOT, 'Scratch')
    const ledger = await openTab(app, ROOT, 'Lane · Ledger connector')
    const names = { [notes]: 'Release notes', [scratch]: 'Scratch', [ledger]: 'Ledger connector' }
    const named = (ids) => ids.map((id) => names[id] ?? id)
    const work = await client.call('clave_set_work', {
      sessionId: ledger,
      unit: 'lane-ledger',
      kind: 'lane',
      label: 'Ledger connector',
      role: 'lead'
    })
    t.check('the ledger tab is given a lane', !toolErrored(work), errorText(work))
    const entry = `[data-work-unit="lane-ledger"]`
    const drawn = await until(async () => ((await win.locator(entry).count()) > 0 ? true : null))
    t.check('the lane is drawn as an entry', drawn === true)
    await win.waitForTimeout(500)
    const middleOf = (sel) => () => centerOf(win, sel)

    // ── 1. A tab over the middle of the entry ──
    await dragTo(win, await centerOf(win, ownRowSel(notes)), middleOf(ownRowSel(scratch)))
    eq('over the middle of an ordinary tab, that tab is marked', named(await ontoMarked(win)), [
      'Scratch'
    ])
    await hoverTo(win, middleOf(rowSel(ledger)))
    eq('over the middle of the lane entry, no row is marked', named(await ontoMarked(win)), [])
    await release(win)
    await win.waitForTimeout(1200)
    eq('a release there nests nothing', (await nestedUnderAll(app))[notes] ?? null, null)
    eq('and writes no link on the record', recordOf(DIR, notes)?.spawnedBy ?? null, null)

    // ── 2. The entry over the middle of a tab ──
    // Held over a tab's edge first: a line is offered there, so the entry is
    // being dragged and the next check is not passing on a drag that never began.
    await dragTo(win, await centerOf(win, rowSel(ledger)), () =>
      centerOf(win, ownRowSel(scratch), { yFraction: 0.08 })
    )
    t.check(
      'the lane entry is dragged like a row: a line is offered at a tab’s edge',
      (await dropLines(win)) > 0,
      { lines: await dropLines(win) }
    )
    await hoverTo(win, middleOf(ownRowSel(scratch)))
    eq(
      'held over the middle of that tab, the lane entry marks no row',
      named(await ontoMarked(win)),
      []
    )
    await cancelDrag(win)
    eq(
      'and the tab that leads the lane is nested nowhere',
      (await nestedUnderAll(app))[ledger] ?? null,
      null
    )
  } finally {
    await app.close()
  }
}
