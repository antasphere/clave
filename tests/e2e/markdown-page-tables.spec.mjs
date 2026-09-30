/**
 * The markdown page editor at width, and its tables.
 *
 * Three things a wide document showed (2026-09-15, a company-os note with four
 * tables): the page stayed a 44rem band in the middle of a full-screen pane;
 * every table carried a "cropped column" on its left that would not scroll —
 * MDXEditor's 2rem column of row "···" triggers, dressed as a data cell by the
 * page's own td rules (borders, and padding that clipped a 2rem button); and
 * clicking one of those "···" did nothing — the row/column menu portals into a
 * container MDXEditor appends to <body> at z-index 2, under the pane, so it
 * opened where nobody could see or click it.
 */
import { launchApp, seedWorkspaces, userDataDir, callMcp, fixturePath } from './harness.mjs'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

const DIR = userDataDir('markdown-page-tables')
const ROOT = fixturePath('root-mdtables')
const WS = {
  id: 'aaaaaaaa-0000-4000-8000-0000000000e2',
  name: 'Docs',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const DOC = `# Wide

| Donnée | Valeur | Source |
|---|---|---|
| Capital | 1 000 actions à 2,50 € : Luca 475, Romain 525, une cellule longue qui doit prendre la place | statuts |
| Pool | 150 warrants | Cyrille |
`

export async function run(t) {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(`${ROOT}/wide.md`, DOC)
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })

  const { app, win } = await launchApp(DIR)
  try {
    await win.setViewportSize({ width: 1800, height: 1000 })
    await callMcp(app, 'openFile', { path: `${ROOT}/wide.md` })
    await win.waitForTimeout(2500)

    // 1. The page takes the pane's width, not a band in the middle of it.
    const width = await win.evaluate(() => {
      const page = document.querySelector('.markdown-page-editor')
      const pane = page?.parentElement
      return page && pane
        ? { page: page.getBoundingClientRect().width, pane: pane.getBoundingClientRect().width }
        : null
    })
    t.check('the page editor is mounted', !!width, width)
    t.check(
      'the page fills its pane (no 44rem band on a wide window)',
      !!width && width.page >= width.pane - 1,
      width
    )

    // 2. The tool frame around a table is not a column of the table.
    const table = await win.evaluate(() => {
      const t = document.querySelector('.markdown-page-content table')
      if (!t) return null
      const tool = t.querySelector('tbody td[data-tool-cell]')
      const first = t.querySelector('tbody tr:nth-child(2) td:not([data-tool-cell])')
      const cs = getComputedStyle(tool)
      const button = tool.querySelector('button')
      const bb = button.getBoundingClientRect()
      const tb = tool.getBoundingClientRect()
      const cells = [...t.querySelectorAll('tbody tr:nth-child(2) td:not([data-tool-cell])')].map(
        (c) => Math.round(c.getBoundingClientRect().width)
      )
      return {
        layout: getComputedStyle(t).tableLayout,
        toolPadding: cs.paddingLeft,
        toolBorder: cs.borderBottomWidth,
        buttonInsideCell: bb.left >= tb.left - 0.5 && bb.right <= tb.right + 0.5,
        toolHangsInGutter: tb.right <= first.getBoundingClientRect().left + 0.5,
        contentStartsAtText:
          Math.abs(
            first.getBoundingClientRect().left -
              document.querySelector('.markdown-page-content').getBoundingClientRect().left
          ) < 1,
        cells
      }
    })
    t.check('the table is mounted with its tool cells', !!table, table)
    if (table) {
      t.equal('the row-tools cell has no padding to crop its button', table.toolPadding, '0px')
      t.equal('the row-tools cell draws no cell border', table.toolBorder, '0px')
      t.check('the "···" button sits whole inside its cell', table.buttonInsideCell, table)
      t.check(
        'the tool column hangs in the gutter, left of the data',
        table.toolHangsInGutter,
        table
      )
      t.check(
        'the first data column starts where the text starts',
        table.contentStartsAtText,
        table
      )
      t.equal('columns size to their content, not to an even split', table.layout, 'auto')
      t.check(
        'the long column is wider than the short ones',
        table.cells[1] > table.cells[0] && table.cells[1] > table.cells[2],
        table.cells
      )
    }

    // 3. Clicking a row's "···" opens a menu the user can see and click.
    const trigger = await win.$('.markdown-page-content table tbody td[data-tool-cell] button')
    t.check('a row "···" trigger exists', !!trigger)
    if (trigger) {
      await trigger.click()
      await win.waitForTimeout(500)
      const menu = await win.evaluate(() => {
        const pop = document.querySelector('[class*="tableColumnEditorPopoverContent"]')
        if (!pop) return null
        const b = pop.getBoundingClientRect()
        const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
        const bg = getComputedStyle(pop).backgroundColor
        return {
          onTop: !!top && pop.contains(top),
          topWas: top?.className?.toString().slice(0, 40),
          opaque: !/rgba\(\d+, \d+, \d+, 0\)/.test(bg) && bg !== 'transparent',
          bg,
          buttons: [...pop.querySelectorAll('button')].map((b) => b.title)
        }
      })
      t.check('the row menu opens', !!menu, menu)
      t.check('the row menu is above the pane, not under it', menu?.onTop, menu)
      t.check('the row menu has an opaque surface', menu?.opaque, menu)
      t.check(
        'the row menu offers insert above / below / delete',
        menu?.buttons?.length === 3 && menu.buttons.some((x) => /delete/i.test(x)),
        menu?.buttons
      )
      // And its buttons take a click: delete the row, the table loses one.
      const rowsBefore = await win.evaluate(
        () => document.querySelectorAll('.markdown-page-content table tbody tr').length
      )
      await win.click('[class*="tableColumnEditorPopoverContent"] button[title*="Delete"]')
      await win.waitForTimeout(500)
      const rowsAfter = await win.evaluate(
        () => document.querySelectorAll('.markdown-page-content table tbody tr').length
      )
      t.equal('clicking "Delete this row" removes the row', rowsAfter, rowsBefore - 1)
    }
  } finally {
    await app.close()
  }
}
