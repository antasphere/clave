// A look at nested tabs, not a check (PRDCT-4997, PRDCT-4998): launches the
// real app through the e2e harness, opens tabs behind a recording CLI, nests
// some under others, and screenshots the sidebar in each state a person meets
// (the folded count, the unfolded rows, a row waiting on the person, a drag
// onto a row, a drag between two rows, a nested row dragged out, the two menu
// entries) into the folder named by CLAVE_LOOK_OUT, in the four themes.
// It runs through the runner, from the specs folder (the runner's alternate
// specs-dir mode boots no app, so copy it beside the specs for the run):
//   npx electron-vite build
//   sed -e "s#'../#'./#g" tests/e2e/look/nested-tabs.spec.mjs > tests/e2e/zz-look.spec.mjs
//   CLAVE_LOOK_OUT=/tmp/shots node tests/e2e/run.mjs zz-look; rm tests/e2e/zz-look.spec.mjs
// Nothing here asserts beyond having run; the screenshots are for eyes, and
// are never committed. It lives outside the specs folder so CI never runs it.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  callMcp,
  until
} from '../harness.mjs'

const out = process.env.CLAVE_LOOK_OUT || '/tmp/clave-look-nested'
const DIR = userDataDir('look-nested-tabs')
const ROOT = fixturePath('look-nested-tabs-root')
const WS = {
  id: 'look-nested',
  name: 'Nested tabs',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const THEMES = ['dark', 'light', 'coffee', 'charcoal']

export async function run(t) {
  mkdirSync(out, { recursive: true })
  mkdirSync(`${ROOT}/bin`, { recursive: true })
  // A recording stand-in for the agent CLI: it sets the terminal's title to
  // each line it is given, which is how a state is put on a tab. No provider
  // and no account is called.
  writeFileSync(
    `${ROOT}/bin/codex`,
    `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(ROOT)} + '/started-' + process.env.CLAVE_SESSION_ID, 'recording-only')
const esc = String.fromCharCode(27)
const title = value => process.stdout.write(esc + ']0;' + value + String.fromCharCode(7))
title('codex | Ready')
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const clean = line.split(esc + '[I').join('').split(esc + '[O').join('')
  title(clean.trim())
})
`,
    { mode: 0o755 }
  )
  writeFileSync(
    `${ROOT}/bin/sh`,
    `#!/bin/sh
export PATH='${ROOT}/bin':"$PATH"
[ "$1" = '-l' ] && shift
exec /bin/sh "$@"
`,
    { mode: 0o755 }
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win } = await launchApp(DIR, {
    server: 'in-process',
    env: { SHELL: `${ROOT}/bin/sh`, PATH: `${ROOT}/bin:${process.env.PATH}` }
  })
  try {
    const open = async (name, mode = 'codex') => {
      const result = await callMcp(app, 'openSession', { cwd: ROOT, name, mode })
      assert.ok(result?.sessionId, JSON.stringify(result))
      if (mode === 'codex')
        assert.ok(
          await until(() => existsSync(`${ROOT}/started-${result.sessionId}`)),
          `the recording CLI must start for ${name}`
        )
      return result.sessionId
    }
    const store = (fn, arg) =>
      win.evaluate(
        ({ source, arg }) =>
          new Function('store', 'arg', `return (${source})(store, arg)`)(
            window.__claveSessionStoreForTests,
            arg
          ),
        { source: fn.toString(), arg }
      )
    const nest = (id, under) =>
      store((s, a) => s.getState().nestSession(a.id, a.under), { id, under })
    const unfold = (id, open_) =>
      store((s, a) => s.getState().setNestExpanded(a.id, a.open), { id, open: open_ })
    const say = async (id, title, state) => {
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
    const row = (id) => `[data-sidebar-item-id="${id}"]`
    const centerOf = async (selector, at = 0.5) => {
      const box = await win.locator(selector).first().boundingBox()
      return { x: box.x + box.width / 2, y: box.y + box.height * at }
    }
    const theme = (name) =>
      win.evaluate((name) => {
        const root = document.documentElement
        for (const key of Array.from(root.style))
          if (key.startsWith('--')) root.style.removeProperty(key)
        root.dataset.theme = name
      }, name)
    // The rows alone, with a little air: what the eye judges. `extra` adds
    // selectors whose boxes must be in the picture too (a menu, the ghost).
    const shot = async (name, extra = []) => {
      const clip = await win.evaluate((extra) => {
        const visible = (el) =>
          !el.closest('[data-group-collapsed="true"]') &&
          !el.closest('[data-nest-collapsed="true"]')
        const rows = [...document.querySelectorAll('[data-sidebar-item-id]')].filter(visible)
        const boxes = [
          ...rows,
          ...document.querySelectorAll('.group-scope'),
          ...extra.flatMap((selector) => [...document.querySelectorAll(selector)])
        ].map((el) => el.getBoundingClientRect())
        const left = Math.min(...boxes.map((b) => b.left))
        const top = Math.min(...boxes.map((b) => b.top))
        const right = Math.max(...boxes.map((b) => b.right))
        const bottom = Math.max(...boxes.map((b) => b.bottom))
        return {
          x: Math.max(0, Math.floor(left - 10)),
          y: Math.max(0, Math.floor(top - 12)),
          width: Math.ceil(right - left + 20),
          height: Math.ceil(bottom - top + 26)
        }
      }, extra)
      await win.screenshot({ path: path.join(out, `${name}.png`), clip })
    }

    // The two cards a fresh instance shows at the foot of its sidebar say
    // nothing about nested tabs: out of the picture.
    await win
      .getByRole('button', { name: 'Turn off' })
      .click({ timeout: 5000 })
      .catch(() => {})
    await win
      .getByRole('button', { name: 'Dismiss' })
      .click({ timeout: 5000 })
      .catch(() => {})

    // Two lanes as a person meets them after two handovers each: the tab
    // that works, the two it took over from, a terminal serving its page.
    const lead = await open('Lane · Invoice export')
    const gen1 = await open('Lane · Invoice export · gen 1')
    const gen2 = await open('Lane · Invoice export · gen 2')
    const page = await open('Page · invoice export (port 4795)', 'terminal')
    const docs = await open('Release notes')
    const ledger = await open('Lane · Ledger connector')
    const verifier = await open('Verifier · round 2')
    const helper = await open('Ledger · fixtures')
    const loose = await open('Scratch terminal', 'terminal')
    const { groupId } = await callMcp(app, 'createGroup', { name: 'Billing' })
    for (const id of [ledger, verifier, helper])
      await callMcp(app, 'moveSession', { sessionId: id, groupId })
    await store((s, a) => s.getState().setGroupColor(a, 'blue'), groupId)
    await win.locator(row(lead)).waitFor()
    await win.locator(row(docs)).locator('.sidebar-item').click()

    // 01: before anything is nested, the rows as they stand.
    await theme('dark')
    await win.waitForTimeout(400)
    await shot('01-nothing-nested-dark')

    for (const id of [gen1, gen2, page]) assert.deepEqual(await nest(id, lead), { ok: true })
    for (const id of [verifier, helper]) assert.deepEqual(await nest(id, ledger), { ok: true })
    await unfold(lead, false)
    await unfold(ledger, false)
    await win.locator(row(docs)).locator('.sidebar-item').click()
    await win.waitForTimeout(400)

    for (const name of THEMES) {
      await theme(name)
      await win.waitForTimeout(350)
      await shot(`02-folded-${name}`)
    }

    // 03: a nested tab waits on the person, another works: the folded counts say so.
    await say(gen2, '[ ! ] Action Required | codex', 'blocked')
    await say(verifier, 'codex | Working', 'working')
    for (const name of THEMES) {
      await theme(name)
      await win.waitForTimeout(350)
      await shot(`03-folded-signals-${name}`)
    }

    // 04: both nests unfolded, a nested row selected.
    await unfold(lead, true)
    await unfold(ledger, true)
    await win.waitForTimeout(450)
    await win.locator(row(gen1)).locator('.sidebar-item').click()
    await win.mouse.move(900, 500)
    await win.waitForTimeout(300)
    for (const name of THEMES) {
      await theme(name)
      await win.waitForTimeout(350)
      await shot(`04-unfolded-${name}`)
    }
    await say(gen2, 'codex | Ready', 'idle')
    await say(verifier, 'codex | Ready', 'idle')
    // The two that just finished are read, so nothing is left to signal.
    for (const id of [gen2, verifier, docs]) {
      await win.locator(row(id)).locator('.sidebar-item').click()
      await win.waitForTimeout(200)
    }

    // 05: the count under the pointer.
    for (const name of ['dark', 'light']) {
      await theme(name)
      await win
        .locator(`${row(lead)} .sidebar-nest-toggle`)
        .first()
        .hover()
      await win.waitForTimeout(350)
      await shot(`05-count-hover-${name}`)
    }
    await win.mouse.move(900, 500)

    // 06 to 08: a drag, held at the three places that mean three things.
    const hold = async (from, to, name) => {
      await win.mouse.move(from.x, from.y)
      await win.mouse.down()
      const steps = 12
      for (let i = 1; i <= steps; i++) {
        await win.mouse.move(
          from.x + ((to.x - from.x) * i) / steps,
          from.y + ((to.y - from.y) * i) / steps
        )
        await win.waitForTimeout(25)
      }
      await win.waitForTimeout(500)
      for (const themeName of ['dark', 'light']) {
        await theme(themeName)
        await win.waitForTimeout(250)
        await shot(`${name}-${themeName}`, ['.sidebar-drag-overlay'])
      }
      await win.keyboard.press('Escape')
      await win.mouse.up()
      // A key was just pressed: the row that kept the focus would wear the
      // keyboard's focus ring in the next picture.
      await win.evaluate(() => document.activeElement?.blur?.())
      await win.waitForTimeout(300)
    }
    await unfold(ledger, false)
    await win.waitForTimeout(400)
    await hold(await centerOf(row(docs)), await centerOf(row(ledger), 0.5), '06-drag-onto-a-tab')
    await hold(
      await centerOf(row(loose)),
      await centerOf(row(docs), 0.88),
      '07-drag-between-two-tabs'
    )
    await hold(
      await centerOf(row(gen2)),
      await centerOf(row(docs), 0.12),
      '08-drag-a-nested-tab-out'
    )

    // 09 and 10: the two entries of the row's menu.
    for (const name of ['dark', 'light']) {
      await theme(name)
      // On plain terminals, whose menu carries no account header.
      await win.locator(row(loose)).locator('.sidebar-item').click({ button: 'right' })
      await win.getByText('Attach to', { exact: true }).hover()
      await win.waitForTimeout(500)
      await shot(`09-menu-attach-${name}`, ['.menu-surface'])
      await win.keyboard.press('Escape')
      await win.waitForTimeout(250)
      await win.locator(row(page)).locator('.sidebar-item').click({ button: 'right' })
      await win.waitForTimeout(400)
      await shot(`10-menu-detach-${name}`, ['.menu-surface'])
      await win.keyboard.press('Escape')
      await win.waitForTimeout(250)
    }
    t.check('the look ran', true)
  } finally {
    await app.close()
  }
}
