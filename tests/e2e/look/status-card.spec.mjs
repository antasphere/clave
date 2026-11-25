// A look at the status card (PRDCT-5166), not a check: launches the real
// app through the e2e harness, has the echo adapter answer with a status
// block, and screenshots the card in the Chat, Enclave and Folio views, in
// the four themes, in its three states, into the folder CLAVE_LOOK_OUT names
// (default /tmp/clave-look-status-card):
//   (1) the card asks something (a decision and a next step), current;
//   (2) the card owes nothing, current, with the card before it now past;
//   (3) Folio only: the page before, its card past.
// It runs through the runner, from the specs folder (copy it beside the
// specs for the run):
//   npx electron-vite build
//   sed -e "s#'../#'./#g" tests/e2e/look/status-card.spec.mjs > tests/e2e/zz-look.spec.mjs
//   node tests/e2e/run.mjs zz-look; rm tests/e2e/zz-look.spec.mjs
// Nothing here asserts beyond having run; the screenshots are for eyes, and
// are never committed. It lives outside the specs folder so CI never runs it.
// Every word of the work is invented.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { until } from '../harness.mjs'
import { openChat, selectChatView } from '../chat-view.spec.mjs'

const out = process.env.CLAVE_LOOK_OUT || '/tmp/clave-look-status-card'
const THEMES = ['light', 'dark', 'coffee', 'charcoal']
const VIEWS = { chat: 'chat-view', terminal: 'terminal-view', lab: 'folio-view' }
const block = (...lines) => ['```clave-status', ...lines, '```'].join('\n')
const ASKS = `The planner now orders the beds by the date of the last frost, and \`sortBeds\` keeps the old order as a fallback.\n\n${block(
  'doing: ordering the greenhouse beds by frost date',
  'where: the **sort** is done and its tests pass; the seed trays still use the old order',
  'decide: move the seed trays to the same order? I would: one rule is easier to explain',
  'next: say yes or no to the seed trays'
)}`
const NOTHING = `The seed trays follow the same order now.\n\n${block(
  'doing: ordering the greenhouse beds by frost date',
  'where: beds and trays share one rule, merged on `main`',
  'next: nothing'
)}`

export async function run(t) {
  mkdirSync(out, { recursive: true })
  const { win, record, close } = await openChat('look-status-card')
  try {
    const theme = (name) =>
      win.evaluate((name) => {
        const root = document.documentElement
        for (const key of Array.from(root.style))
          if (key.startsWith('--')) root.style.removeProperty(key)
        root.dataset.theme = name
      }, name)
    const view = (kind) => win.locator(`[data-testid="${VIEWS[kind]}"]`)
    const send = async (text) => {
      await selectChatView(win, record.id, 'chat')
      const chat = view('chat')
      const before = await chat.getByTestId('status-card').count()
      const composer = chat.locator('textarea')
      await composer.fill(text)
      await composer.press('Enter')
      await until(async () =>
        (await chat.getByTestId('status-card').count()) > before ? true : null
      )
      await win.waitForTimeout(800)
    }
    const shoot = async (state, kinds = ['chat', 'terminal', 'lab']) => {
      for (const kind of kinds) {
        await selectChatView(win, record.id, kind)
        await view(kind).getByTestId('status-card').first().waitFor()
        await win.mouse.move(2, 2)
        await win.waitForTimeout(800)
        for (const name of THEMES) {
          await theme(name)
          await win.waitForTimeout(300)
          await view(kind).screenshot({ path: path.join(out, `${kind}-${name}-${state}.png`) })
        }
      }
    }

    await send(ASKS)
    await shoot('1-asks')
    await send(NOTHING)
    await shoot('2-nothing-and-past')
    await selectChatView(win, record.id, 'lab')
    await view('lab').locator('[aria-label="Previous page"]').click()
    await win.waitForTimeout(900)
    await shoot('3-past', ['lab'])
    t.check('the look ran', true)
  } finally {
    await close()
  }
}
