/**
 * Ongoing conversations (PRDCT-4190), in the real app.
 *
 * A long-lived conversation (the accountant, an email thread) is moved out of
 * the sidebar into a place of its own, opened from one card at the sidebar's
 * foot, and kept across a restart:
 *
 *  1. A Claude tab's menu offers "Move to Ongoing"; a plain terminal's does not.
 *  2. Moved, the row leaves the sidebar, its group says "Kept in Ongoing", and
 *     the foot card shows, counting one.
 *  3. The foot card opens the page; the conversation's card is on it; a click
 *     puts the conversation in the pane, the sidebar still without its row.
 *  4. After a restart whose process did not survive, the conversation is NOT
 *     behind the restore prompt, is still on the page, and opening it
 *     resumes the same conversation (`--resume <id>`) in a tab that stays
 *     out of the sidebar.
 *  5. "Back to the sidebar" puts the row back and the foot card goes.
 *
 * Fails if any of those comes back wrong: a row still drawn, a missing card,
 * a prompt holding the conversation, a resume of anything else.
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

const DIR = userDataDir('ongoing-conversations')
const ROOT = fixturePath('ongoing-conversations-root')
const BIN = `${ROOT}/bin`
const STARTS = `${ROOT}/agent-starts.jsonl`
const WS = {
  id: 'ongoing-ws-0000-4000-8000-00000000000a',
  name: 'Ongoing',
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

function writeFixtures() {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  // A Claude that logs how it was started, then stays up saying nothing.
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

async function menuLabels(win, id) {
  await win.click(`${rowSel(id)} .sidebar-item`, { button: 'right' })
  await win.waitForTimeout(300)
  const labels = await win.getByRole('menuitem').allInnerTexts()
  return labels.map((l) => l.trim())
}

const shelf = (win) =>
  win.evaluate((sel) => {
    const el = document.querySelector(sel)
    return el
      ? {
          count: Number(el.getAttribute('data-ongoing-count')),
          pressed: el.getAttribute('aria-pressed') === 'true'
        }
      : null
  }, SHELF)

const drawn = (win, id) => win.evaluate((sel) => !!document.querySelector(sel), rowSel(id))

export async function run(t) {
  writeFixtures()
  let { app, win } = await launchApp(DIR)
  let conversationId = null
  let tmuxName = null
  let sessionId = null
  try {
    const group = await callMcp(app, 'createGroup', { name: 'Admin' })
    const opened = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      profile: 'stub-claude',
      name: 'Accountant'
    })
    sessionId = opened.sessionId
    await callMcp(app, 'moveSession', { sessionId, groupId: group.groupId })
    const shell = await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal', name: 'shell' })
    await until(async () => (await drawn(win, sessionId)) && (await drawn(win, shell.sessionId)))
    const rec = await win.evaluate(async (id) => {
      const r = (await window.electronAPI.listSessionRecords({ ids: [id] })).find((s) => s.id === id)
      return r ? { claudeSessionId: r.claudeSessionId ?? null, tmuxName: r.tmuxName ?? null } : null
    }, sessionId)
    conversationId = rec?.claudeSessionId ?? null
    tmuxName = rec?.tmuxName ?? null
    t.check('the Claude tab carries its conversation id', !!conversationId, conversationId)
    t.check('no foot card while nothing is ongoing', (await shelf(win)) === null)

    // ── 1. The menus ──
    const shellMenu = await menuLabels(win, shell.sessionId)
    await win.keyboard.press('Escape')
    t.check(
      'a plain terminal is not offered "Move to Ongoing"',
      !shellMenu.includes('Move to Ongoing') && shellMenu.length > 0,
      shellMenu
    )
    const claudeMenu = await menuLabels(win, sessionId)
    t.check(
      'a Claude tab is offered "Move to Ongoing"',
      claudeMenu.includes('Move to Ongoing'),
      claudeMenu
    )

    // ── 2. Moved ──
    await win.getByRole('menuitem', { name: 'Move to Ongoing' }).click()
    await win.waitForTimeout(600)
    t.check('the row leaves the sidebar', !(await drawn(win, sessionId)))
    const placeholder = await win.evaluate(
      (gid) => document.querySelector(`[data-sidebar-empty-group="${gid}"]`)?.textContent?.trim(),
      group.groupId
    )
    t.check('its group says where it went', placeholder === 'Kept in Ongoing', placeholder)
    const s1 = await shelf(win)
    t.check('the foot card shows one', s1?.count === 1, s1)

    // ── 3. The page and the pane ──
    await win.click(SHELF)
    await win.waitForSelector(PAGE, { timeout: 5000 })
    const cards = await win.$$eval('[data-ongoing-card]', (els) =>
      els.map((e) => ({
        session: e.getAttribute('data-session-id'),
        title: e.querySelector('.ongoing-card-title')?.textContent
      }))
    )
    t.check(
      'the page holds the conversation’s card',
      cards.length === 1 && cards[0].session === sessionId && cards[0].title === 'Accountant',
      cards
    )
    t.check('the foot card reads as pressed on the page', (await shelf(win))?.pressed === true)
    await win.click('[data-ongoing-card]')
    await win.waitForTimeout(600)
    const after = await win.evaluate(() => ({
      page: !!document.querySelector('[data-ongoing-page]')
    }))
    const listed = await callMcp(app, 'list', {})
    t.check(
      'a click puts the conversation in the pane',
      !after.page && listed.focusedSessionId === sessionId,
      { after, focused: listed.focusedSessionId }
    )
    t.check('and the sidebar still has no row for it', !(await drawn(win, sessionId)))

    // The note is the person's own line on the card.
    await win.click(SHELF)
    await win.waitForSelector(PAGE)
    await win.hover('[data-ongoing-card]')
    await win.click('.ongoing-note')
    await win.fill('.ongoing-note-input', 'Waiting for the VAT reply')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(400)
    const note = await win.textContent('.ongoing-note')
    t.check('a note is written on the card', note?.trim() === 'Waiting for the VAT reply', note)

    // ── 4. The restart, the conversation's process gone as after a reboot ──
    await win.waitForTimeout(800)
    await app.close()
    app = null
    await new Promise((r) => setTimeout(r, 1500))
    if (tmuxName) {
      try {
        execFileSync('tmux', ['-L', 'clave', 'kill-session', '-t', `=${tmuxName}`], {
          timeout: 10_000
        })
      } catch {
        // already gone
      }
    }
    const before = starts().length
    const second = await launchApp(DIR, { settleMs: 4000 })
    app = second.app
    win = second.win
    const boot = await win.evaluate(() => document.documentElement.dataset.boot)
    t.check('the boot does not stop on a restore prompt for it', boot !== 'restore-prompt', boot)
    const back = await until(async () => {
      const s = await shelf(win)
      return s?.count === 1 ? s : null
    })
    t.check('the foot card is back with the conversation', !!back, back)
    const rows = await callMcp(app, 'list', {})
    const anyRow = await Promise.all(rows.sessions.map((s) => drawn(win, s.id)))
    t.check(
      'no tab of it is drawn in the sidebar',
      !rows.sessions.some((s, i) => anyRow[i] && s.name === 'Accountant'),
      rows.sessions.map((s) => s.name)
    )
    await win.click(SHELF)
    await win.waitForSelector(PAGE)
    const kept = await win.$$eval('[data-ongoing-card]', (els) =>
      els.map((e) => ({
        status: e.getAttribute('data-ongoing-status'),
        note: e.querySelector('.ongoing-note')?.textContent?.trim()
      }))
    )
    t.check(
      'its card is on the page with its note, resting',
      kept.length === 1 &&
        kept[0].note === 'Waiting for the VAT reply' &&
        kept[0].status === 'resting',
      kept
    )
    await win.click('[data-ongoing-card]')
    const resumed = await until(async () => {
      const s = starts()
        .slice(before)
        .find((x) => x.args.includes('--resume'))
      return s ?? null
    })
    t.check(
      'opening it resumes the same conversation',
      !!resumed && resumed.args.includes(conversationId),
      { resumed, conversationId }
    )
    await win.waitForTimeout(800)
    const live = await callMcp(app, 'list', {})
    const tab = live.sessions.find((s) => s.id === resumed?.session)
    t.check('the resumed tab is in the pane', !!tab && live.focusedSessionId === tab.id, {
      tab,
      focused: live.focusedSessionId
    })
    t.check('and out of the sidebar', !!tab && !(await drawn(win, tab.id)))

    // ── 5. Back to the sidebar ──
    await win.click(SHELF)
    await win.waitForSelector(PAGE)
    await win.click('[data-ongoing-card]', { button: 'right' })
    await win.waitForTimeout(300)
    await win.getByRole('menuitem', { name: 'Back to the sidebar' }).click()
    await win.waitForTimeout(800)
    t.check('the row is drawn again', !!tab && (await drawn(win, tab.id)))
    t.check('the foot card goes', (await shelf(win)) === null)
  } finally {
    if (app) await app.close()
  }
}
