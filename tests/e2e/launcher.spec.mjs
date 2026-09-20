/**
 * The session launcher (PRDCT-1663 / PRDCT-1664).
 *
 * Selectors here are the design-system classes, not button labels. The first
 * version of these checks keyed on `title === 'New session'` and went silently
 * dead the moment that title changed — a rename must fail a check loudly or not
 * at all, never turn it into a no-op that still exits 0.
 */
import {
  launchApp,
  seedWorkspaces,
  userDataDir,
  stubFolderDialog,
  sidebarRows,
  agentButtonLabel,
  selectBuiltIn
} from './harness.mjs'
import { mkdirSync } from 'node:fs'

const DIR = userDataDir('launcher')
const ROOT_A = '/tmp/clave-e2e-root-a'
const ROOT_B = '/tmp/clave-e2e-root-b'
const WS_A = {
  id: 'aaaaaaaa-0000-4000-8000-00000000000a',
  name: 'Alpha',
  rootDir: ROOT_A,
  profileFile: null,
  createdAt: 1
}
const WS_B = {
  id: 'bbbbbbbb-0000-4000-8000-00000000000b',
  name: 'Beta',
  rootDir: ROOT_B,
  profileFile: null,
  createdAt: 2
}

export async function run(t) {
  mkdirSync(ROOT_A, { recursive: true })
  mkdirSync(ROOT_B, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS_A, WS_B], activeWorkspaceId: WS_A.id, fresh: true })

  let { app, win } = await launchApp(DIR)
  try {
    const dialogCalls = await stubFolderDialog(app)

    // ── shape ──
    const shape = await win.evaluate(() => {
      const row = document.querySelector('.launcher-row')
      if (!row) return null
      return {
        buttons: row.querySelectorAll('button').length,
        caret: !!row.querySelector('.launcher-caret'),
        split: !!row.querySelector('.launcher-split')
      }
    })
    t.check('the launcher row exists', shape !== null, shape)
    t.equal('it has four controls: terminal, agent, caret, folder', shape?.buttons, 4)
    t.check('the caret is welded to the agent button', shape?.caret && shape?.split, shape)

    // ── PRDCT-1663: pinned outside the scrolling viewport ──
    const containment = await win.evaluate(() => {
      const btn = document.querySelector('.launcher-row button')
      const sidebar = btn?.closest('.flex.flex-col.h-full')
      const viewport = sidebar
        ? [...sidebar.querySelectorAll('div')].find((d) =>
            /(auto|scroll)/.test(getComputedStyle(d).overflowY)
          )
        : null
      return { foundViewport: !!viewport, launcherInside: viewport ? viewport.contains(btn) : null }
    })
    t.check('the sidebar has a scrolling viewport', containment.foundViewport, containment)
    t.equal('the launcher is NOT inside it', containment.launcherInside, false)

    // ── PRDCT-1664: launches at the workspace root, no folder dialog ──
    await win.click('.launcher-row button')
    await win.waitForTimeout(4000)
    t.equal('clicking Terminal opened no folder dialog', await dialogCalls(), 0)
    const rows = await sidebarRows(win)
    t.check('it spawned a session at the workspace root', rows.includes('clave-e2e-root-a'), rows)

    // ── the caret changes what a plain click launches ──
    t.equal('the agent button starts on Claude', await agentButtonLabel(win), 'Claude')
    await win.click('.launcher-caret')
    await win.waitForTimeout(800)
    await selectBuiltIn(win, 'Codex CLI', 'Codex', 'codex')
    await win.waitForTimeout(4000)
    t.equal('picking Codex makes it the remembered agent', await agentButtonLabel(win), 'Codex')
    t.equal('and still no folder dialog', await dialogCalls(), 0)

    // ── the memory is PER WORKSPACE ──
    // Switching goes through the toolbar's workspace popover — the sidebar's
    // pill row was retired when the switcher moved up there.
    const switchTo = async (name) => {
      await win.click('button[aria-label="Switch workspace"]')
      await win.waitForTimeout(600)
      await win.click(`[data-radix-popper-content-wrapper] button:has-text("${name}")`)
      await win.waitForTimeout(1500)
    }
    await switchTo('Beta')
    t.equal('a different workspace keeps its own agent', await agentButtonLabel(win), 'Claude')
    await switchTo('Alpha')
    t.equal('switching back restores Alpha’s', await agentButtonLabel(win), 'Codex')
  } finally {
    await app.close()
  }

  // ── and it survives a restart ──
  await new Promise((r) => setTimeout(r, 1500))
  seedWorkspaces(DIR, { workspaces: [WS_A, WS_B], activeWorkspaceId: WS_A.id })
  ;({ app, win } = await launchApp(DIR))
  try {
    t.equal('the remembered agent survives a restart', await agentButtonLabel(win), 'Codex')
  } finally {
    await app.close()
  }
}
