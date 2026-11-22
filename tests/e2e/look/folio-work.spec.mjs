// A look at Folio's work dock (PRDCT-4833), not a check: launches the real
// app through the e2e harness, puts work on the desk and screenshots the
// Folio pane in the four themes into the folder CLAVE_LOOK_OUT names
// (default /tmp/clave-look-folio-work):
//   (a) three running, one of them quiet, closed;
//   (b) the same, open;
//   (c) seven running, open (the +N on the pill, the card's scroll);
//   (d) a narrow pane (about 520 px), closed and open, with the back pill;
//   and the motion: the pill and the open card in light and dark at three
//   moments a second apart (a third of the marks' cycle).
// It runs through the runner, from the specs folder (copy it beside the
// specs for the run):
//   npx electron-vite build
//   sed -e "s#'../#'./#g" tests/e2e/look/folio-work.spec.mjs > tests/e2e/zz-look.spec.mjs
//   node tests/e2e/run.mjs zz-look; rm tests/e2e/zz-look.spec.mjs
// Nothing here asserts beyond having run; the screenshots are for eyes, and
// are never committed. It lives outside the specs folder so CI never runs it.
// Every name in the work is invented.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { until } from '../harness.mjs'
import { openChat, inject } from '../chat-view.spec.mjs'

const out = process.env.CLAVE_LOOK_OUT || '/tmp/clave-look-folio-work'
const FOLIO = ['--dev-echo-view=clave.chat-view/lab']
const READY = '[data-testid="folio-view"] textarea:not(:disabled)'
const THEMES = ['light', 'dark', 'coffee', 'charcoal']

const agentCall = (id, type, description) => ({
  type: 'tool_call',
  id,
  name: 'Agent',
  input: { subagent_type: type, description, run_in_background: true }
})
const shellCall = (id, command, description) => ({
  type: 'tool_call',
  id,
  name: 'Bash',
  input: { command, description, run_in_background: true }
})
const task = (id, kind, call, description, startedAt = Date.now()) => ({
  id,
  kind,
  description,
  toolUseId: call,
  startedAt
})

export async function run(t) {
  mkdirSync(out, { recursive: true })
  const { win, record, fixture, close } = await openChat('look-folio-work', FOLIO, READY)
  try {
    const tile = `[data-terminal-tile="${record.id}"]`
    const shown = `${tile} .chat-content-slot:not([hidden])`
    const view = win.locator(`${shown} [data-testid="folio-view"]`)
    const pill = win.locator(`${shown} [data-testid="folio-work-pill"]`)
    const dock = win.locator(`${shown} [data-testid="folio-work"]`)
    const theme = (name) =>
      win.evaluate((name) => {
        const root = document.documentElement
        for (const key of Array.from(root.style))
          if (key.startsWith('--')) root.style.removeProperty(key)
        root.dataset.theme = name
      }, name)
    const shot = (name) => view.screenshot({ path: path.join(out, `${name}.png`) })
    const setOpen = async (want) => {
      const now = (await dock.getAttribute('data-open')) === 'pinned'
      if (now !== want) await pill.click()
      await win.mouse.move(2, 2)
      await win.waitForTimeout(700)
    }
    const input = view.locator('textarea[aria-label="Message"]')
    for (const text of [
      'How should the invented greenhouse planner order its beds?',
      'And which of the seed trays should go out first this spring?'
    ]) {
      await input.fill(text)
      await input.press('Enter')
      await win.waitForTimeout(1500)
    }

    /* (a), (b): three running, one quiet. */
    const three = [
      task('t-a', 'agent', 'call-a', 'Survey the seed catalogue for early varieties'),
      task('t-c', 'shell', 'bash-c', 'Serve the planner'),
      task('t-q', 'agent', 'call-q', 'Sort the compost notes', Date.now() - 130_000)
    ]
    await inject(fixture, record.id, [
      agentCall('call-a', 'Explore', 'Survey the seed catalogue for early varieties'),
      shellCall('bash-c', 'npm run serve -- --port 4400 --host 127.0.0.1', 'Serve the planner'),
      { type: 'tool_result', id: 'bash-c', output: 'Command running in background with ID: t-c' },
      { type: 'background_tasks', tasks: three },
      { type: 'subagent_model', parent: 'call-a', model: 'claude-sonnet-5-5' },
      { type: 'tool_call', id: 'a1', name: 'Grep', input: { pattern: 'tulip' }, parent: 'call-a' },
      {
        type: 'tool_call',
        id: 'a2',
        name: 'Read',
        input: { file_path: '/garden/catalogue/early-varieties.md' },
        parent: 'call-a'
      },
      { type: 'context_usage', used: 48_000, window: null, parent: 'call-a' },
      { type: 'state_change', state: 'done' }
    ])
    await until(async () => (await pill.count()) === 1)
    await win.waitForTimeout(1500)
    /* The motion, which a still cannot show: the pill and the open card at
       three moments a third of a cycle (two breaths) apart. */
    for (const name of ['light', 'dark']) {
      await theme(name)
      await setOpen(false)
      for (const at of [0, 1, 2]) {
        await pill.screenshot({ path: path.join(out, `${name}-motion-pill-${at}.png`) })
        await win.waitForTimeout(1000)
      }
      await setOpen(true)
      const card = win.locator(`${shown} [data-testid="folio-work-card"]`)
      for (const at of [0, 1, 2]) {
        await card.screenshot({ path: path.join(out, `${name}-motion-card-${at}.png`) })
        await win.waitForTimeout(1000)
      }
      await setOpen(false)
    }
    for (const name of THEMES) {
      await theme(name)
      await setOpen(false)
      await shot(`${name}-a-three-closed`)
      await setOpen(true)
      await shot(`${name}-b-three-open`)
    }
    await setOpen(false)

    /* (c): seven running, open. */
    const more = [
      ['call-d', 'Plan', 'Draft the watering rota for the summer weeks'],
      ['call-e', 'general-purpose', 'Compare the frost dates of three regions'],
      ['call-f', 'Explore', 'Find every bed the planner has no soil type for']
    ]
    await inject(fixture, record.id, [
      ...more.map(([id, type, d]) => agentCall(id, type, d)),
      shellCall('bash-g', 'npm test -- --watch', 'Watch the tests'),
      { type: 'tool_result', id: 'bash-g', output: 'Command running in background with ID: t-g' },
      {
        type: 'background_tasks',
        tasks: [
          ...three,
          ...more.map(([id, , d]) => task(`t-${id}`, 'agent', id, d)),
          task('t-g', 'shell', 'bash-g', 'Watch the tests')
        ]
      }
    ])
    await win.waitForTimeout(1200)
    for (const name of THEMES) {
      await theme(name)
      await setOpen(true)
      await shot(`${name}-c-seven-open`)
    }
    await setOpen(false)

    /* (d): a narrow pane, the back pill showing (page 1 of 2). */
    await inject(fixture, record.id, [{ type: 'background_tasks', tasks: three }])
    await view.locator('.folio-spine [aria-label="Previous page"]').click()
    await win.evaluate((sel) => {
      const host = document.querySelector(sel)
      host.style.width = '520px'
      host.style.maxWidth = '520px'
      host.style.flex = '0 0 520px'
    }, `${shown} [data-testid="folio-view"]`)
    await win.waitForTimeout(900)
    const measure = await view.evaluate((el) => {
      const r = (s) => el.querySelector(s)?.getBoundingClientRect()?.toJSON() ?? null
      return {
        view: r(':scope'),
        pill: r('[data-testid="folio-work-pill"]'),
        back: r('.folio-back'),
        continued: r('.chat-continued-from')
      }
    })
    console.log('narrow geometry', JSON.stringify(measure))
    for (const name of THEMES) {
      await theme(name)
      await setOpen(false)
      await shot(`${name}-d-narrow-closed`)
      await setOpen(true)
      await shot(`${name}-d-narrow-open`)
    }
    t.check('the look ran', true)
  } finally {
    await close()
  }
}
