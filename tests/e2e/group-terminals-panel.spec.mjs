/**
 * The group header's terminals button and panel (PRDCT-1670).
 *
 * The header used to lay every terminal's icon out in a row that ran off the
 * sidebar past a handful, truncating the group's name first. Now it carries
 * two controls whatever the count — a `+` for a new session, then a terminals
 * button (count then icon, lit in a running terminal's colour) — and the
 * terminals live in a panel the button opens to its RIGHT, over the session
 * area, on hover or click.
 *
 * Order and side are asserted from the rendered boxes rather than the markup:
 * both are things you only notice by looking at the row, and both are one
 * prop away from silently going back to what they were.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath
} from './harness.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const DIR = userDataDir('group-terminals-panel')
const ROOT = fixturePath('terminals-panel-root')
const CLAVE = `${ROOT}/many.clave`
const WS = {
  id: 'cccccccc-0000-4000-8000-00000000000c',
  name: 'Terminals',
  rootDir: ROOT,
  profileFile: CLAVE,
  createdAt: 1
}

const COLORS = ['green', 'teal', 'blue', 'purple', 'yellow', 'pink', 'red', 'black', 'green', 'teal', 'blue', 'purple']
const ICONS = ['bolt', 'globe', 'cube', 'eye', 'signal', 'fire', 'rocket', 'star', 'heart', 'wrench', 'beaker', 'cloud']
const TERMINAL_COUNT = 12

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(
    CLAVE,
    JSON.stringify(
      {
        $schema: 'clave/1.0',
        groups: [
          {
            // A single-digit count, for the last phase: the gap between the
            // button's edge and the digit only exists at one digit.
            name: 'Five',
            cwd: '.',
            color: 'blue',
            sessions: [
              { cwd: '.', name: 'five-seed', claudeMode: false, antigravityMode: false, codexMode: false, dangerousMode: false }
            ],
            terminals: Array.from({ length: 5 }, (_, i) => ({
              command: `echo five-${i + 1}`,
              commandMode: 'prefill',
              color: COLORS[i],
              icon: ICONS[i]
            }))
          },
          {
            name: 'A group with a dozen terminals and a long name',
            cwd: '.',
            color: 'teal',
            sessions: [
              { cwd: '.', name: 'seed', claudeMode: false, antigravityMode: false, codexMode: false, dangerousMode: false }
            ],
            terminals: Array.from({ length: TERMINAL_COUNT }, (_, i) => ({
              // prefill: the command is typed, never run, so nothing lingers.
              command: `echo terminal-${i + 1}`,
              commandMode: 'prefill',
              color: COLORS[i],
              icon: ICONS[i]
            }))
          }
        ]
      },
      null,
      2
    )
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR)
  try {
    await win.click('button[aria-label="Add a group"]')
    await win.waitForTimeout(700)
    await win.locator('.group-picker-card', { hasText: 'dozen' }).first().click()
    await win.waitForTimeout(5000)

    const header = win.locator('[data-sidebar-item-type="group"]').first()
    t.check('the group is on screen', (await header.count()) === 1)

    // ── Nothing runs off the sidebar, and the name keeps room ──
    const geometry = await win.evaluate(() => {
      const headerEl = document.querySelector('[data-sidebar-item-type="group"]')
      const btn = headerEl?.querySelector('[data-group-terminals]')
      const plus = headerEl?.querySelector('[aria-label^="New session in"]')
      const name = headerEl?.querySelector('span.truncate')
      const box = (el) => (el ? el.getBoundingClientRect() : null)
      return {
        header: box(headerEl),
        btn: box(btn),
        plus: box(plus),
        name: box(name),
        count: btn?.querySelector('.group-terminals-count')?.textContent ?? null,
        countBox: box(btn?.querySelector('.group-terminals-count')),
        iconBox: box(btn?.querySelector('svg')),
        oldIconRow: headerEl?.querySelectorAll('.terminal-icon').length ?? 0,
        addRows: document.querySelectorAll('.group-add-row').length
      }
    })
    t.check('the terminals button is inside the header', geometry.btn && geometry.btn.right <= geometry.header.right + 0.5, geometry)
    t.check('the + is inside the header', geometry.plus && geometry.plus.right <= geometry.header.right + 0.5, geometry)
    t.check('the + comes first, the terminals button last', geometry.plus.right <= geometry.btn.left + 0.5, {
      plus: geometry.plus.right,
      btn: geometry.btn.left
    })
    t.check('the count reads before the icon it counts', geometry.countBox && geometry.iconBox && geometry.countBox.right <= geometry.iconBox.left + 0.5, {
      count: geometry.countBox,
      icon: geometry.iconBox
    })
    t.check('the name still has at least 60px', geometry.name && geometry.name.width >= 60, geometry)
    t.equal('the button shows the terminal count', geometry.count, String(TERMINAL_COUNT))
    t.equal('no per-terminal icons are laid out in the header any more', geometry.oldIconRow, 0)
    t.equal('the per-group "New session" row is gone', geometry.addRows, 0)

    // ── Hover opens the panel with every terminal and a "New terminal" row ──
    await header.locator('[data-group-terminals]').hover()
    await win.waitForTimeout(500)
    const panel = win.locator('[data-group-terminals-panel]')
    t.equal('hovering the button opens the panel', await panel.count(), 1)
    // Clear of the SIDEBAR, not merely of the button: the button sits a row's
    // padding in from the edge, so a panel that only clears the button still
    // covers the list it was moved out of.
    const side = await win.evaluate(() => {
      const btn = document.querySelector('[data-group-terminals]')
      const shell = document.querySelector('[data-sidebar-shell]')
      const row = document.querySelector('[data-sidebar-item-type="group"]')
      const p = document.querySelector('[data-group-terminals-panel]')
      const box = p.getBoundingClientRect()
      return {
        btnRight: btn.getBoundingClientRect().right,
        btnTop: btn.getBoundingClientRect().top,
        sidebarRight: shell?.getBoundingClientRect().right ?? null,
        rowTop: row.getBoundingClientRect().top,
        panelLeft: box.left,
        panelTop: box.top
      }
    })
    t.check('the sidebar shell is measurable', side.sidebarRight !== null, side)
    t.check('the panel opens to the RIGHT of the button', side.panelLeft >= side.btnRight, side)
    t.check('and entirely clear of the sidebar', side.panelLeft >= side.sidebarRight, side)
    // Level with the GROUP, not with the button centred inside it — off by the
    // row's own padding is exactly what you see, and only when you look.
    t.check(
      "its top is the group row's top",
      Math.abs(side.panelTop - side.rowTop) <= 2,
      { panelTop: side.panelTop, rowTop: side.rowTop, btnTop: side.btnTop }
    )
    t.equal('the panel lists every terminal', await panel.locator('[data-terminal-row]').count(), TERMINAL_COUNT)
    t.equal('the panel ends with a New terminal row', await panel.locator('[data-add-terminal]').count(), 1)
    t.equal('nothing is running yet', await panel.locator('[data-terminal-row][data-running="true"]').count(), 0)

    // ── Clicking a row starts that terminal; the button lights up ──
    await panel.locator('[data-terminal-row]').nth(2).click()
    await win.waitForTimeout(2500)
    const lit = await header.locator('[data-group-terminals][data-running="true"]').count()
    t.equal('the terminals button is lit once a terminal runs', lit, 1)
    const litColor = await header.locator('[data-group-terminals]').evaluate((el) => el.style.color)
    t.check('it carries the running terminal\'s colour', litColor && litColor !== '', litColor)

    await header.locator('[data-group-terminals]').hover()
    await win.waitForTimeout(500)
    t.equal('the panel marks that terminal as running', await panel.locator('[data-terminal-row][data-running="true"]').count(), 1)

    // ── Leaving closes it ──
    await win.mouse.move(5, 5)
    await win.waitForTimeout(600)
    t.equal('the panel closes when the cursor leaves', await panel.count(), 0)

    // ── A single-digit count sits tight against the button's edge ──
    // The count used to be laid into a box wide enough for two digits and
    // right-aligned in it, so "5" floated a visible gap in from the border
    // while "12" filled the box — which is why this needs its own group: at
    // two digits the padding is invisible and nothing catches it.
    await win.click('button[aria-label="Add a group"]')
    await win.waitForTimeout(700)
    await win.locator('.group-picker-card', { hasText: 'Five' }).first().click()
    await win.waitForTimeout(5000)
    const tight = await win.evaluate(() => {
      const row = [...document.querySelectorAll('[data-sidebar-item-type="group"]')].find((el) =>
        el.textContent?.startsWith('Five')
      )
      const btn = row?.querySelector('[data-group-terminals]')
      const countEl = btn?.querySelector('.group-terminals-count')
      if (!btn || !countEl) return null
      // The DIGIT's own box, not the span around it: a span padded out to two
      // digits keeps its left edge where it was and hides the gap inside.
      const range = document.createRange()
      range.selectNodeContents(countEl)
      return {
        text: countEl.textContent,
        gap: range.getBoundingClientRect().left - btn.getBoundingClientRect().left
      }
    })
    t.check('the five-terminal group is on screen', tight !== null, tight)
    t.equal('its button says 5', tight?.text, '5')
    // 4px of deliberate air, and nothing like the ~10px a two-digit-wide box
    // put there: the threshold sits between the two, so the box coming back
    // fails this even though a pixel of tuning does not.
    t.check('and the digit sits close to the button edge', tight.gap <= 5.5, tight)
  } finally {
    await app.close()
  }
}
