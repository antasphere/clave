/**
 * Ongoing conversations, the follow-ups (PRDCT-4207, PRDCT-4208), in the real app:
 * - A1: the card shows the last exchange of a conversation kept under its own account directory;
 * - F7: a resting conversation with no transcript starts fresh under its own id, not a failing resume;
 * - L1-L3: the lock the windows share around saving the list exists on the app's origin, and holds
 *   across two windows (the store falls back to unlocked saving where it is refused, so only this
 *   spec can tell that it is really held).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  openWindow,
  until
} from './harness.mjs'

const DIR = userDataDir('ongoing-followups')
const ROOT = fixturePath('ongoing-followups-root')
const BIN = `${ROOT}/bin`
const ACCOUNT = `${ROOT}/account-home`
const SHARED = `${ROOT}/shared-projects`
const STARTS = `${ROOT}/agent-starts.jsonl`
const WS = {
  id: 'ongoing-followups-ws-0000-4000-8000-000000000011',
  name: 'ProbeFollowups',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const SHELF = '[data-ongoing-shelf]'
const PAGE = '[data-ongoing-page]'
const card = (name) => `[data-ongoing-card]:has(.ongoing-card-title:text-is("${name}"))`
const starts = () =>
  existsSync(STARTS)
    ? readFileSync(STARTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []
const dashed = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-')
const SAID = 'Send the accountant the Q3 file before Friday'

const entry = (id, name, conversationId, launch) => ({
  id,
  workspaceId: WS.id,
  sessionId: `gone-${id}`,
  provider: 'claude',
  conversationId,
  name,
  cwd: ROOT,
  note: '',
  originGroup: null,
  addedAt: Date.now(),
  launch: { launchProfileId: 'stub-claude', ...launch }
})

function writeFixtures() {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  mkdirSync(SHARED, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  // The account's own transcript, under its directory and not under the shared root.
  const dir = path.join(ACCOUNT, 'projects', dashed(ROOT))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'conv-acct.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-11-08T10:00:00.000Z',
        message: { content: SAID }
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Noted.' }] }
      })
    ].join('\n') + '\n'
  )
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

export async function run(t) {
  writeFixtures()
  const { app, win } = await launchApp(DIR, { env: { CLAVE_TRANSCRIPTS_ROOT: SHARED } })
  try {
    await win.evaluate(
      (list) => window.electronAPI.preferencesSet('ongoingConversations', list),
      [
        entry('acct', 'Accountant', 'conv-acct', { claudeConfigDir: ACCOUNT }),
        entry('quiet', 'Never spoke', '7d0c1c39-2d6e-4b8e-9d8a-5f3c2a1b0e11', {})
      ]
    )
    await win.evaluate(() => window.dispatchEvent(new Event('focus')))
    await until(() => win.evaluate((s) => !!document.querySelector(s), SHELF))
    await win.click(SHELF)
    await win.waitForSelector(PAGE, { timeout: 5000 })

    const shown = await until(async () => {
      const text = await win.$eval(card('Accountant'), (el) => el.textContent ?? '').catch(() => '')
      return text.includes(SAID) ? text : null
    })
    t.check(
      "A1 the card shows the last exchange of a conversation kept under its account's directory",
      !!shown,
      shown
    )

    // F7: no transcript anywhere for this one; opening it starts fresh under its own id.
    const before = starts().length
    await win.click(card('Never spoke'))
    const started = await until(() => starts().slice(before)[0] ?? null)
    t.check(
      'F7 a conversation with no transcript starts fresh under its own id',
      !!started &&
        started.args.includes('--session-id 7d0c1c39-2d6e-4b8e-9d8a-5f3c2a1b0e11') &&
        !started.args.includes('--resume'),
      started?.args
    )

    // L1-L3: the lock exists on this origin and holds across two windows.
    const w2 = await openWindow(app, win, WS.id, { settleMs: 1500 })
    const has = await Promise.all(
      [win, w2.page].map((p) =>
        p.evaluate(async () => {
          if (!navigator.locks?.request) return 'missing'
          try {
            return await navigator.locks.request('clave-ongoing-probe', async () => 'held')
          } catch (err) {
            return `refused: ${err?.name ?? err}`
          }
        })
      )
    )
    t.check(
      'L1 both windows hold the lock on the app origin',
      has.every((h) => h === 'held'),
      has
    )

    const holding = win.evaluate(
      () =>
        new Promise((resolve) => {
          navigator.locks.request('clave-ongoing-conversations', async () => {
            const at = Date.now()
            await new Promise((r) => setTimeout(r, 1500))
            resolve({ from: at, to: Date.now() })
          })
        })
    )
    await win.waitForTimeout(300)
    const second = await w2.page.evaluate(() =>
      navigator.locks.request('clave-ongoing-conversations', async () => Date.now())
    )
    const first = await holding
    t.check(
      "L2 the second window's request waits for the first window's hold",
      second >= first.to,
      { first, second }
    )

    // L3: a save from window 2 while window 1 holds the lock lands after it, and is not lost.
    const hold = win.evaluate(
      () =>
        new Promise((resolve) => {
          navigator.locks.request('clave-ongoing-conversations', async () => {
            const list = await window.electronAPI.preferencesGet('ongoingConversations')
            await new Promise((r) => setTimeout(r, 1000))
            await window.electronAPI.preferencesSet('ongoingConversations', [
              ...list,
              { ...list.find((e) => e.id === 'acct'), id: 'from-window-1', name: 'From window 1' }
            ])
            resolve(true)
          })
        })
    )
    await win.waitForTimeout(200)
    // Window 2's own app path: a note written on the Accountant card goes through the store's update.
    await w2.page.click(SHELF).catch(() => {})
    await w2.page.waitForSelector(PAGE, { timeout: 5000 })
    await w2.page.click(card('Accountant'), { button: 'right' })
    await w2.page.waitForTimeout(300)
    const noteItem = w2.page.getByRole('menuitem', { name: /note/i })
    let noteWritten = false
    if (await noteItem.count()) {
      await noteItem.first().click()
      await w2.page.keyboard.type('Call on Monday')
      await w2.page.keyboard.press('Enter')
      noteWritten = true
    }
    await hold
    await w2.page.waitForTimeout(1500)
    const saved = await win.evaluate(() =>
      window.electronAPI.preferencesGet('ongoingConversations')
    )
    const ids = saved.map((e) => e.id)
    const acct = saved.find((e) => e.id === 'acct')
    t.check(
      "L3 a save from window 2 during window 1's hold keeps both changes",
      noteWritten && ids.includes('from-window-1') && acct?.note === 'Call on Monday',
      { noteWritten, ids, note: acct?.note }
    )
  } finally {
    await app.close()
  }
}
