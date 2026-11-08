/**
 * Ongoing conversations (PRDCT-4190): the group header, the card menu, a group delete and a resting card put back, in the real app. Written by the verifier of round 1 as proofs of F1, F3 and F5; each check now pins the fix.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  callMcp,
  until
} from './harness.mjs'

const DIR = userDataDir('ongoing-menus')
const ROOT = fixturePath('ongoing-menus-root')
const BIN = `${ROOT}/bin`
const STARTS = `${ROOT}/agent-starts.jsonl`
const WS = {
  id: 'ongoing-menus-ws-0000-4000-8000-00000000000b',
  name: 'Probe',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const rowSel = (id) => `[data-sidebar-item-id="${id}"]`
const SHELF = '[data-ongoing-shelf]'
const PAGE = '[data-ongoing-page]'
const starts = () =>
  existsSync(STARTS)
    ? readFileSync(STARTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []
const drawn = (win, id) => win.evaluate((sel) => !!document.querySelector(sel), rowSel(id))

function writeFixtures() {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(
    `${BIN}/claude`,
    `#!/bin/sh\nargs=$(printf '%s' "$*" | tr -d '"\\\\' | cut -c1-200)\necho '{"session":"'"$CLAVE_SESSION_ID"'","args":"'"$args"'"}' >> ${JSON.stringify(STARTS)}\nexec sleep 600\n`,
    { mode: 0o755 }
  )
  writeFileSync(
    path.join(DIR, 'agent-launch-profiles.json'),
    JSON.stringify({
      version: 1,
      customProfiles: [
        {
          id: 'stub-claude',
          name: 'Stub Claude',
          family: 'claude',
          command: [`${BIN}/claude`],
          additionalArgs: []
        }
      ],
      globalDefaults: {},
      workspaceOverrides: {}
    })
  )
}

async function moveViaMenu(win, id) {
  await win.click(`${rowSel(id)} .sidebar-item`, { button: 'right' })
  await win.waitForTimeout(300)
  await win.getByRole('menuitem', { name: 'Move to Ongoing' }).click()
  await win.waitForTimeout(600)
}

export async function run(t) {
  writeFixtures()
  let { app, win } = await launchApp(DIR)
  const tmuxNames = []
  try {
    const group = await callMcp(app, 'createGroup', { name: 'Admin' })
    const acc = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      profile: 'stub-claude',
      name: 'Accountant'
    })
    await callMcp(app, 'moveSession', { sessionId: acc.sessionId, groupId: group.groupId })
    const other = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      profile: 'stub-claude',
      name: 'Other'
    })
    await callMcp(app, 'moveSession', { sessionId: other.sessionId, groupId: group.groupId })
    await until(
      async () => (await drawn(win, acc.sessionId)) && (await drawn(win, other.sessionId))
    )
    for (const id of [acc.sessionId, other.sessionId]) {
      const r = await win.evaluate(
        async (i) => (await window.electronAPI.listSessionRecords({ ids: [i] })).find((s) => s.id === i),
        id
      )
      if (r?.tmuxName) tmuxNames.push(r.tmuxName)
    }
    const l0 = await callMcp(app, 'list', {})
    const g0 = l0.groups.find((g) => g.id === group.groupId)
    t.check(
      '[setup] Accountant listed first in its group',
      JSON.stringify(g0?.sessionIds ?? g0?.sessions ?? g0).indexOf(acc.sessionId) <
        JSON.stringify(g0?.sessionIds ?? g0?.sessions ?? g0).indexOf(other.sessionId),
      g0
    )

    await moveViaMenu(win, acc.sessionId)
    t.check('[setup] Accountant hidden', !(await drawn(win, acc.sessionId)))

    // ── P1: clicking the group header must not put the hidden ongoing tab in the pane ──
    await callMcp(app, 'focus', { sessionId: other.sessionId }).catch(() => {})
    await win.click(
      `[data-sidebar-item-id="${group.groupId}"][data-sidebar-item-type="group"] button.group-header`,
      { position: { x: 120, y: 10 } }
    )
    await win.waitForTimeout(500)
    const l1 = await callMcp(app, 'list', {})
    t.check(
      'P1 group header click does not focus the ongoing (hidden) tab',
      l1.focusedSessionId !== acc.sessionId,
      { focused: l1.focusedSessionId, acc: acc.sessionId }
    )
    const sh = await win.evaluate(
      (s) => document.querySelector(s)?.getAttribute('aria-pressed'),
      SHELF
    )
    t.check('P1b the shelf does not read pressed after a plain group click', sh !== 'true', sh)

    // ── P2: "Add a note" from the card's menu keeps the page and opens the note input ──
    await win.click(SHELF)
    await win.waitForSelector(PAGE, { timeout: 5000 })
    await win.click('[data-ongoing-card]', { button: 'right' })
    await win.waitForTimeout(300)
    await win.getByRole('menuitem', { name: 'Add a note' }).click()
    await win.waitForTimeout(600)
    const p2 = await win.evaluate(() => ({
      page: !!document.querySelector('[data-ongoing-page]'),
      input: !!document.querySelector('.ongoing-note-input')
    }))
    t.check(
      'P2 "Add a note" from the menu keeps the page open with the note input',
      p2.page && p2.input,
      p2
    )

    // ── P3: Delete the group: the ongoing tab survives, entry kept, still hidden ──
    // P1's click selected the group's one visible row; a second click on a
    // selected group folds it, so unfold it before reaching the row.
    await win.keyboard.press('Escape')
    const reachable = await win.evaluate(
      (sel) => {
        const el = document.querySelector(sel)
        if (!el) return false
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return !!hit && el.contains(hit)
      },
      `${rowSel(other.sessionId)} .sidebar-item`
    )
    if (!reachable) {
      await win.click(
        `[data-sidebar-item-id="${group.groupId}"][data-sidebar-item-type="group"] button.group-header`,
        { position: { x: 120, y: 10 } }
      )
      await win.waitForTimeout(400)
    }
    await win.click(`${rowSel(other.sessionId)} .sidebar-item`)
    await win.waitForTimeout(400)
    const pre3 = await callMcp(app, 'list', {})
    t.check(
      '[setup] P3 focus on Other before delete',
      pre3.focusedSessionId === other.sessionId,
      pre3.focusedSessionId
    )
    if (
      !(await win.$(`[data-sidebar-item-id="${group.groupId}"][data-sidebar-item-type="group"]`))
    ) {
      // P2 navigated away; nothing to do
    }
    await win.click(
      `[data-sidebar-item-id="${group.groupId}"][data-sidebar-item-type="group"] button.group-header`,
      { button: 'right' }
    )
    await win.waitForTimeout(300)
    await win.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    await win.waitForTimeout(1500)
    const l3 = await callMcp(app, 'list', {})
    const accAlive = l3.sessions.find((s) => s.id === acc.sessionId)
    t.check(
      'P3 group delete keeps the ongoing tab',
      !!accAlive,
      l3.sessions.map((s) => s.name)
    )
    t.check('P3 group delete leaves it hidden', !(await drawn(win, acc.sessionId)))
    const s3 = await win.evaluate(
      (s) => document.querySelector(s)?.getAttribute('data-ongoing-count'),
      SHELF
    )
    t.check('P3 group delete keeps the entry', s3 === '1', s3)
    t.check(
      'P3 group delete closes the non-ongoing member',
      !l3.sessions.find((s) => s.id === other.sessionId)
    )
    t.check(
      'P3 focus is not on the hidden ongoing tab after the delete',
      l3.focusedSessionId !== acc.sessionId,
      l3.focusedSessionId
    )

    // ── P4: after a reboot, "Back to the sidebar" on a resting card resumes ONCE ──
    await win.waitForTimeout(800)
    await app.close()
    app = null
    await new Promise((r) => setTimeout(r, 1500))
    for (const n of tmuxNames) {
      try {
        execFileSync('tmux', ['-L', 'clave', 'kill-session', '-t', `=${n}`], { timeout: 10_000 })
      } catch {}
    }
    const before = starts().length
    const second = await launchApp(DIR, { settleMs: 4000 })
    app = second.app
    win = second.win
    await until(async () => !!(await win.$(SHELF)))
    await win.click(SHELF)
    await win.waitForSelector(PAGE)
    const status = await win.getAttribute('[data-ongoing-card]', 'data-ongoing-status')
    t.check('[setup] resting after reboot', status === 'resting', status)
    await win.click('[data-ongoing-card]', { button: 'right' })
    await win.waitForTimeout(300)
    await win.getByRole('menuitem', { name: 'Back to the sidebar' }).click()
    await win.waitForTimeout(3000)
    const resumes = starts()
      .slice(before)
      .filter((x) => x.args.includes('--resume'))
    t.check(
      'P4 "Back to the sidebar" on a resting card resumes exactly once',
      resumes.length === 1,
      resumes
    )
    const l4 = await callMcp(app, 'list', {})
    const accTabs = l4.sessions.filter((s) => s.name === 'Accountant')
    t.check(
      'P4 exactly one Accountant tab exists',
      accTabs.length === 1,
      l4.sessions.map((s) => s.name)
    )
    const shown = await Promise.all(accTabs.map((s) => drawn(win, s.id)))
    t.check(
      'P4 and every Accountant tab is drawn in the sidebar (no hidden leftover)',
      shown.every(Boolean),
      shown
    )
    const ent = await win.evaluate(
      async () => await window.electronAPI.preferencesGet('ongoingConversations')
    )
    t.check(
      'P4 no entry left behind in the preferences',
      Array.isArray(ent) && ent.length === 0,
      ent
    )
  } finally {
    if (app) await app.close()
  }
}
