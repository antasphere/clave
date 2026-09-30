import { until } from './harness.mjs'
import { inject, openChat } from './chat-view.spec.mjs'

/* Markdown tables in an assistant turn. The case that started it: a table of
   modules with a long French description column and a short price column,
   where the price column shrank to one character and stacked "3.500" digit
   over digit. Each column must keep its longest word, the prose column taking
   the squeeze; a table too wide even at its words scrolls in its own frame
   instead of pushing the transcript sideways. Measured on the laid-out text:
   a price that wrapped is more than one line box. */

const DESCRIPTION =
  "Le call produit une fiche. L'agent propose la classification (full deal ou specialist support) et contrôle les conflits d'intérêts. Il pré-remplit le mémo du comité d'investissement et la forme de prix."

const PRICED = [
  '| # | Module | Ce que ça fait pour Dups | Prix |',
  '|---|---|---|---|',
  ...['3.500', '6.000', '7.000', '5.500'].map(
    (price, i) => `| ${i} | **Heures, facturation, relances** | ${DESCRIPTION} | ${price} |`
  )
].join('\n')

const WIDE = [
  `| ${Array.from({ length: 12 }, (_, i) => `Colonne${i}`).join(' | ')} |`,
  `|${'---|'.repeat(12)}`,
  `| ${Array.from({ length: 12 }, (_, i) => `valeur-insécable-${i}`).join(' | ')} |`
].join('\n')

export async function run(t) {
  const { app, win, record, close } = await openChat('chat-tables')
  try {
    // About the width of the screenshot's pane, where the bug showed.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 800))
    await inject(app, record.id, [{ type: 'assistant_text', delta: PRICED, final: true }])
    const view = win.locator('[data-testid="chat-view"]')
    await view.locator('.chat-prose table').first().waitFor()

    const lines = await until(async () => {
      const found = await view
        .locator('.chat-prose table')
        .first()
        .evaluate((table) => {
          const count = (cell) => {
            const range = document.createRange()
            range.selectNodeContents(cell)
            return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size
          }
          return [...table.querySelectorAll('tr')].map((row) => ({
            text: row.lastElementChild.textContent,
            lines: count(row.lastElementChild)
          }))
        })
      return found.length === 5 ? found : null
    })
    t.check(
      'a short price column keeps each price on one line beside a long prose column',
      lines && lines.every((cell) => cell.lines === 1),
      lines
    )

    const wrapped = await view
      .locator('.chat-prose table')
      .first()
      .evaluate((table) => table.rows[1].cells[2].getBoundingClientRect().height)
    const rowHeight = await view
      .locator('.chat-prose table')
      .first()
      .evaluate((table) => table.rows[0].getBoundingClientRect().height)
    t.check('the prose column is the one that wraps', wrapped > rowHeight * 1.5, {
      wrapped,
      rowHeight
    })

    await inject(app, record.id, [{ type: 'assistant_text', delta: WIDE, final: true }])
    await until(async () => (await view.locator('.chat-table-scroll').count()) === 2)
    const frame = await view
      .locator('.chat-table-scroll')
      .nth(1)
      .evaluate((el) => {
        const turn = el.closest('.chat-turn')
        return {
          scrolls: el.scrollWidth > el.clientWidth,
          turnOverflow: turn.scrollWidth - turn.clientWidth
        }
      })
    t.check(
      'a table too wide at its words scrolls inside its own frame, not the turn',
      frame.scrolls && frame.turnOverflow <= 0,
      frame
    )
  } finally {
    await close()
  }
}
