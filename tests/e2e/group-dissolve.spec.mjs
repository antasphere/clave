/**
 * A group's quick-launch terminals die with the group, and an ownerless one
 * never comes back as a tab (PRDCT-2038).
 *
 * The bug, as met on 2026-09-03: deleting a group killed its member tabs and
 * FORGOT its quick-launch terminals — the `npm run dev` behind the group row
 * kept running in tmux with its record on disk, and the next launch, finding
 * no group to hang it off, adopted it as an ordinary tab. Seven mystery rows
 * from two groups deleted the day before. Three rules, each checked here in
 * the real app:
 *
 *  1. Delete stops the terminals (after asking, since one is running) — the
 *     tmux session is gone and so is its record.
 *  2. Ungroup does the same to the terminals while its members become tabs;
 *     with nothing running there is no question.
 *  3. At boot, a linked record whose group no longer exists is discarded —
 *     process stopped, record removed, no tab — and the discard is EXACT: a
 *     dead record's kill must not take a `-2` sibling with it.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  persistedWindows,
  until,
  killLeakedE2eTmux,
  tmuxSessionAlive,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('group-dissolve')
const ROOT = fixturePath('dissolve-root')
const WS = {
  id: 'eeeeeeee-0000-4000-8000-00000000000e',
  name: 'Dissolve',
  rootDir: ROOT,
  createdAt: 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sessionRecords() {
  const dir = path.join(DIR, 'session-records')
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf-8')))
  } catch {
    return []
  }
}

function recordExists(tmuxName) {
  return existsSync(path.join(DIR, 'session-records', `${tmuxName}.json`))
}

/** A detached tmux session on the app's socket, the way a survivor looks. */
function spawnTmux(name) {
  execFileSync('tmux', ['-L', 'clave', 'new-session', '-d', '-s', name, '-c', ROOT, 'sleep 900'])
}

/** A session record as the app writes one for a plain terminal. */
function writeRecord(tmuxName, id, windowKey, link) {
  mkdirSync(path.join(DIR, 'session-records'), { recursive: true })
  writeFileSync(
    path.join(DIR, 'session-records', `${tmuxName}.json`),
    JSON.stringify({
      id,
      cwd: ROOT,
      folderName: path.basename(ROOT),
      claudeMode: false,
      antigravityMode: false,
      codexMode: false,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: false,
      workspaceId: WS.id,
      windowKey,
      ...(link ? { link } : {}),
      tmuxName
    })
  )
}

const dialogText = (win) =>
  win.evaluate(() => document.querySelector('.modal-card')?.textContent ?? null)

async function makeGroupWithTerminal(app, name, command) {
  const group = await callMcp(app, 'createGroup', { name, cwd: ROOT })
  const member = await callMcp(app, 'openSession', {
    cwd: ROOT,
    mode: 'terminal',
    groupId: group.groupId
  })
  const terminal = command
    ? await callMcp(app, 'addGroupTerminal', {
        groupId: group.groupId,
        command,
        commandMode: 'auto',
        cwd: ROOT
      })
    : null
  await sleep(1500)
  return { group, member, terminal }
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  killLeakedE2eTmux()

  let app = null
  // Hex only: the fixture ids below must be real UUIDs or the app prunes
  // the records as malformed and the boot has nothing to decide.
  const rand = randomBytes(6).toString('hex')
  const ORPHAN = `clave-e2e-orphan-${rand}`
  const PFX = `clave-e2e-pfx-${rand}`
  const SIBLING = `${PFX}-2`
  try {
    const first = await launchApp(DIR)
    app = first.app
    let win = first.win

    // ── 1. Delete asks, then stops the running terminal ──
    const del = await makeGroupWithTerminal(app, 'Delete me', 'sleep 900')
    t.check('the group terminal spawned a session', !!del.terminal?.sessionId, del.terminal)
    const delRecord = sessionRecords().find((r) => r.id === del.terminal.sessionId)
    t.check(
      'the terminal has a live tmux session and a record',
      !!delRecord?.tmuxName && tmuxSessionAlive(delRecord.tmuxName),
      delRecord
    )

    await win.click(`[data-sidebar-item-id="${del.group.groupId}"] > button`, { button: 'right' })
    await win.waitForTimeout(350)
    await win.locator('.menu-surface .menu-item', { hasText: 'Delete' }).click()
    await win.waitForSelector('.modal-card', { timeout: 5000 })
    const delText = await dialogText(win)
    t.check(
      'Delete asks first and says it stops the running terminal',
      /1 running terminal/.test(delText ?? '') && /stops/.test(delText ?? ''),
      delText
    )
    await win.locator('.modal-card button', { hasText: 'Delete' }).click()

    const afterDelete = await until(async () => {
      const list = await callMcp(app, 'list', {})
      const gone =
        !list.groups.some((g) => g.id === del.group.groupId) &&
        !list.sessions.some((s) => s.id === del.terminal.sessionId) &&
        !list.sessions.some((s) => s.id === del.member.sessionId)
      return gone ? list : null
    })
    t.check('the group, its member and its terminal left the app', !!afterDelete, 'still listed')
    t.check(
      "the terminal's tmux session is dead",
      !!delRecord?.tmuxName && !tmuxSessionAlive(delRecord.tmuxName),
      delRecord?.tmuxName
    )
    t.check(
      "and the terminal's record is gone (nothing for the next boot to bring back)",
      !!delRecord?.tmuxName && !recordExists(delRecord.tmuxName),
      delRecord?.tmuxName
    )

    // ── 2. Ungroup: members become tabs, the terminal stops; no running
    //       terminal → no question ──
    const ung = await makeGroupWithTerminal(app, 'Ungroup me', 'sleep 900')
    const ungRecord = sessionRecords().find((r) => r.id === ung.terminal.sessionId)
    await win.click(`[data-sidebar-item-id="${ung.group.groupId}"] > button`, { button: 'right' })
    await win.waitForTimeout(350)
    await win.locator('.menu-surface .menu-item', { hasText: 'Ungroup' }).click()
    await win.waitForSelector('.modal-card', { timeout: 5000 })
    const ungText = await dialogText(win)
    t.check(
      'Ungroup asks first: sessions stay as tabs, the terminal stops',
      /keeps its sessions as tabs/.test(ungText ?? '') && /stops that terminal/.test(ungText ?? ''),
      ungText
    )
    await win.locator('.modal-card button', { hasText: 'Ungroup' }).click()
    const afterUngroup = await until(async () => {
      const list = await callMcp(app, 'list', {})
      return !list.groups.some((g) => g.id === ung.group.groupId) ? list : null
    })
    t.check('the group dissolved', !!afterUngroup, 'group still listed')
    t.check(
      'the ungrouped terminal left the session list (not lingering invisibly in the store)',
      !!afterUngroup && !afterUngroup.sessions.some((s) => s.id === ung.terminal.sessionId),
      afterUngroup?.sessions.map((s) => s.id)
    )
    const freedMember = afterUngroup?.sessions.find((s) => s.id === ung.member.sessionId)
    t.check(
      'the member survived as a top-level tab',
      !!freedMember && freedMember.groupId === null && freedMember.alive === true,
      freedMember
    )
    t.check(
      "the ungrouped terminal's tmux session and record are gone",
      !!ungRecord?.tmuxName &&
        !tmuxSessionAlive(ungRecord.tmuxName) &&
        !recordExists(ungRecord.tmuxName),
      ungRecord?.tmuxName
    )

    const quiet = await makeGroupWithTerminal(app, 'Quiet', null)
    await win.click(`[data-sidebar-item-id="${quiet.group.groupId}"] > button`, { button: 'right' })
    await win.waitForTimeout(350)
    await win.locator('.menu-surface .menu-item', { hasText: 'Ungroup' }).click()
    await win.waitForTimeout(600)
    t.check(
      'a group with nothing running ungroups with no question',
      !(await win.evaluate(() => !!document.querySelector('.modal-card'))) &&
        !(await callMcp(app, 'list', {})).groups.some((g) => g.id === quiet.group.groupId)
    )

    // ── 2b. The ungroup KEYBINDING, with the sidebar closed: the dialog
    //        still shows (it lives in the shell, not the sidebar), Cancel
    //        changes nothing, confirm ungroups, and nothing ghosts later ──
    const kb = await makeGroupWithTerminal(app, 'Keybinding', 'sleep 900')
    const kbRecord = sessionRecords().find((r) => r.id === kb.terminal.sessionId)
    await callMcp(app, 'focus', { sessionId: kb.member.sessionId })
    await win.keyboard.press('Meta+B')
    await win.waitForTimeout(600)
    t.check(
      'the sidebar is closed',
      !(await win.evaluate(() => !!document.querySelector('[data-sidebar-shell]')))
    )
    await win.keyboard.press('Meta+Alt+G')
    await win.waitForSelector('.modal-card', { timeout: 5000 })
    const kbText = await dialogText(win)
    t.check(
      'Mod+Alt+G with the sidebar closed still asks about the running terminal',
      /Ungroup/.test(kbText ?? '') && /1 running terminal/.test(kbText ?? ''),
      kbText
    )
    await win.locator('.modal-card button', { hasText: 'Cancel' }).click()
    await win.waitForTimeout(600)
    const afterCancel = await callMcp(app, 'list', {})
    t.check(
      'Cancel changes nothing: group intact, terminal still linked and alive',
      afterCancel.groups.find((g) => g.id === kb.group.groupId)?.terminals?.[0]?.sessionId ===
        kb.terminal.sessionId &&
        !!kbRecord?.tmuxName &&
        tmuxSessionAlive(kbRecord.tmuxName) &&
        !(await win.evaluate(() => !!document.querySelector('.modal-card'))),
      afterCancel.groups.find((g) => g.id === kb.group.groupId)
    )
    await win.keyboard.press('Meta+Alt+G')
    await win.waitForSelector('.modal-card', { timeout: 5000 })
    await win.locator('.modal-card button', { hasText: 'Ungroup' }).click()
    const afterKb = await until(async () => {
      const list = await callMcp(app, 'list', {})
      return !list.groups.some((g) => g.id === kb.group.groupId) ? list : null
    })
    t.check(
      'confirming the keybinding dialog ungroups: member a tab, terminal gone',
      !!afterKb &&
        afterKb.sessions.find((s) => s.id === kb.member.sessionId)?.groupId === null &&
        !afterKb.sessions.some((s) => s.id === kb.terminal.sessionId) &&
        !!kbRecord?.tmuxName &&
        !tmuxSessionAlive(kbRecord.tmuxName),
      afterKb?.sessions
    )
    // Reopen through the toolbar button (the same store action as Mod+B; the
    // shortcut from a bare body after a dialog is not what this spec is about).
    await win.click('button[title="Show sidebar"]')
    await win.waitForTimeout(800)
    const reopened = await win.evaluate(() => ({
      sidebar: !!document.querySelector('[data-sidebar-shell]'),
      dialog: document.querySelector('.modal-card')?.textContent ?? null,
      active: document.activeElement?.tagName ?? null
    }))
    t.check(
      'reopening the sidebar raises no ghost dialog',
      reopened.sidebar && !reopened.dialog,
      reopened
    )

    // ── 3. The boot: an ownerless linked record is discarded, exactly ──
    const key = persistedWindows(DIR)[0]?.key
    t.check('the window persisted a layout key', !!key, persistedWindows(DIR))
    await app.close()
    app = null
    await sleep(1500)

    // A live orphan: the terminal of a group that no longer exists.
    spawnTmux(ORPHAN)
    writeRecord(ORPHAN, 'aaaaaaaa-1111-4111-8111-' + rand, key, {
      kind: 'group-terminal',
      groupId: 'group-1788296388304-2',
      terminalId: 'term-gone'
    })
    // A DEAD orphan whose name prefixes a live, legitimate sibling tab: the
    // discard must not prefix-match its way into the sibling.
    writeRecord(PFX, 'bbbbbbbb-2222-4222-8222-' + rand, key, {
      kind: 'group-terminal',
      groupId: 'group-1788294844508-1',
      terminalId: 'term-gone-too'
    })
    spawnTmux(SIBLING)
    const siblingId = 'cccccccc-3333-4333-8333-' + rand
    writeRecord(SIBLING, siblingId, key, null)
    t.check(
      'fixtures: orphan and sibling alive, dead-prefix record only on disk',
      tmuxSessionAlive(ORPHAN) &&
        tmuxSessionAlive(SIBLING) &&
        !tmuxSessionAlive(PFX) &&
        recordExists(PFX)
    )

    const second = await launchApp(DIR, { settleMs: 8000 })
    app = second.app
    win = second.win
    const booted = await until(async () => {
      const list = await callMcp(app, 'list', {})
      return list.sessions.some((s) => s.id === siblingId) ? list : null
    })
    t.check('the legitimate sibling tab came back', !!booted, 'sibling never adopted')
    const orphanId = 'aaaaaaaa-1111-4111-8111-' + rand
    t.check(
      'the ownerless terminal is NOT a tab',
      !!booted && !booted.sessions.some((s) => s.id === orphanId),
      booted?.sessions.map((s) => s.id)
    )
    await until(async () => (!tmuxSessionAlive(ORPHAN) && !recordExists(ORPHAN) ? true : null))
    t.check('its tmux session was stopped', !tmuxSessionAlive(ORPHAN), ORPHAN)
    t.check('and its record removed', !recordExists(ORPHAN), ORPHAN)
    await until(async () => (!recordExists(PFX) ? true : null))
    t.check("the dead orphan's record was discarded too", !recordExists(PFX), PFX)
    t.check(
      'and the discard was EXACT: the -2 sibling is still alive',
      tmuxSessionAlive(SIBLING) && booted?.sessions.find((s) => s.id === siblingId)?.alive === true,
      { SIBLING, alive: tmuxSessionAlive(SIBLING) }
    )
  } finally {
    if (app) await app.close().catch(() => {})
    killLeakedE2eTmux()
  }
}
