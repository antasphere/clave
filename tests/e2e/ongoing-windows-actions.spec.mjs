/**
 * Ongoing conversations (PRDCT-4190): with two windows on one workspace, every action taken in the window that does not run the tab (open, end, back to the sidebar) acts on that tab and never starts a second agent; the other window follows without being focused (verifier rounds 1 and 2).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  callMcpIn,
  openWindow,
  windows,
  until
} from './harness.mjs'

const DIR = userDataDir('ongoing-windows-actions')
const ROOT = fixturePath('ongoing-windows-actions-root')
// The stub speaks at its first start, as a real tab would before it is moved: its
// transcript is what a resume needs (PRDCT-4208, F7: none means a fresh start).
const TRANSCRIPTS = `${ROOT}/transcripts`
const SPOKEN = `${TRANSCRIPTS}/stub`
const TRANSCRIPTS_ENV = { CLAVE_TRANSCRIPTS_ROOT: TRANSCRIPTS }
const BIN = `${ROOT}/bin`
const STARTS = `${ROOT}/agent-starts.jsonl`
const WS = {
  id: 'ongoing-windows-actions-ws-0000-4000-8000-00000000000f',
  name: 'ProbeMW2',
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
  writeFileSync(
    `${BIN}/claude`,
    `#!/bin/sh\nargs=$(printf '%s' "$*" | tr -d '"\\\\' | cut -c1-200)\necho '{"session":"'"$CLAVE_SESSION_ID"'","args":"'"$args"'"}' >> ${JSON.stringify(STARTS)}\nsid=''; prev=''; for a in "$@"; do [ "$prev" = '--session-id' ] && sid="$a"; prev="$a"; done\n[ -n "$sid" ] && mkdir -p ${JSON.stringify(SPOKEN)} && echo '{"type":"user","message":{"content":"hello"}}' > ${JSON.stringify(SPOKEN)}/"$sid".jsonl\nexec sleep 600\n`,
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

const drawnIn = (page, id) => page.evaluate((s) => !!document.querySelector(s), rowSel(id))
async function moveIn(page, id) {
  await page.click(`${rowSel(id)} .sidebar-item`, { button: 'right' })
  await page.waitForTimeout(300)
  await page.getByRole('menuitem', { name: 'Move to Ongoing' }).click()
  await page.waitForTimeout(800)
}
async function cardMenu(win, name, item) {
  await win.click(`[data-ongoing-card]:has(.ongoing-card-title:text-is("${name}"))`, {
    button: 'right'
  })
  await win.waitForTimeout(300)
  await win.getByRole('menuitem', { name: item }).click()
  await win.waitForTimeout(1500)
}
export async function run(t) {
  writeFixtures()
  const { app, win } = await launchApp(DIR, { env: TRANSCRIPTS_ENV })
  try {
    const w2 = await openWindow(app, win, WS.id, { settleMs: 1500 })
    const ws = await windows(app)
    const id1 = ws[0].id
    const id2 = ws.find((w) => w.page === w2.page)?.id
    const page2 = w2.page
    const names = ['Alpha', 'Beta', 'Gamma']
    const ids = {}
    for (const name of names) {
      const o = await callMcpIn(app, id2, 'openSession', {
        cwd: ROOT,
        mode: 'claude',
        profile: 'stub-claude',
        name
      })
      ids[name] = o.sessionId
      await until(() => drawnIn(page2, o.sessionId))
      await moveIn(page2, o.sessionId)
    }
    await win.evaluate(() => window.dispatchEvent(new Event('focus')))
    await until(() => win.evaluate((s) => !!document.querySelector(s), SHELF))
    await win.click(SHELF)
    await win.waitForSelector(PAGE, { timeout: 5000 })
    const st = await until(async () => {
      const v = await win.$$eval('[data-ongoing-card]', (els) =>
        els.map((e) => e.getAttribute('data-ongoing-status'))
      )
      return v.length === 3 && v.every((x) => x === 'elsewhere') ? v : null
    })
    t.check('N1a all three read "elsewhere" in window 1', !!st, st)

    // Open Alpha from window 1: the tab must arrive in window 1, hidden, focused, and leave window 2.
    const before = starts().length
    await win.click(`[data-ongoing-card]:has(.ongoing-card-title:text-is("Alpha"))`)
    await win.waitForTimeout(3000)
    const l1 = await callMcpIn(app, id1, 'list', {})
    const l2 = await callMcpIn(app, id2, 'list', {})
    t.check(
      'N1b Alpha is now in window 1',
      l1.sessions.some((s) => s.id === ids.Alpha),
      l1.sessions.map((s) => s.name)
    )
    t.check(
      'N1c Alpha left window 2',
      !l2.sessions.some((s) => s.id === ids.Alpha),
      l2.sessions.map((s) => s.name)
    )
    t.check(
      'N1d Alpha is focused in window 1',
      l1.focusedSessionId === ids.Alpha,
      l1.focusedSessionId
    )
    t.check('N1e Alpha stays out of window 1 sidebar', !(await drawnIn(win, ids.Alpha)))
    t.check(
      'N1f no agent started (neither a resume nor a fresh start)',
      starts().slice(before).length === 0
    )

    // End Beta from window 1 while its tab runs in window 2.
    await win.click(SHELF).catch(() => {})
    await win.waitForSelector(PAGE, { timeout: 5000 }).catch(async () => {
      await win.click(SHELF)
      await win.waitForSelector(PAGE)
    })
    await cardMenu(win, 'Beta', 'End conversation')
    const l2b = await callMcpIn(app, id2, 'list', {})
    const beta = l2b.sessions.find((s) => s.id === ids.Beta)
    t.check(
      'N2 "End conversation" from window 1 ends the tab running in window 2',
      !beta,
      beta ? { name: beta.name, alive: beta.alive } : null
    )

    // Back to the sidebar for Gamma from window 1: window 2 draws its row (no focus event sent to window 2).
    const beforeG = starts().length
    await cardMenu(win, 'Gamma', 'Back to the sidebar')
    t.check(
      'N3b "Back to the sidebar" for a tab in window 2 starts no agent (neither a resume nor a fresh start)',
      starts().slice(beforeG).length === 0
    )
    const shown = await until(() => drawnIn(page2, ids.Gamma), { tries: 16, gapMs: 250 })
    t.check(
      'N3 "Back to the sidebar" from window 1 shows the row in window 2 (without refocusing it)',
      !!shown
    )
  } finally {
    await app.close()
  }
}
