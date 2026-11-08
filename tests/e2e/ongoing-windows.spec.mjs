/**
 * Ongoing conversations (PRDCT-4190): two windows on one workspace. A conversation whose tab runs in the other window is never resting here, and opening it never starts a second agent on it (verifier round 1, F2).
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

const DIR = userDataDir('ongoing-windows')
const ROOT = fixturePath('ongoing-windows-root')
const BIN = `${ROOT}/bin`
const STARTS = `${ROOT}/agent-starts.jsonl`
const WS = {
  id: 'ongoing-windows-ws-0000-4000-8000-00000000000c',
  name: 'ProbeMW',
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
  const { app, win } = await launchApp(DIR)
  try {
    const w2 = await openWindow(app, win, WS.id, { settleMs: 1500 })
    const ws = await windows(app)
    const id2 = ws.find((w) => w.page === w2.page)?.id
    const page2 = w2.page
    t.check(
      '[setup] two windows on the same workspace',
      ws.length === 2 && id2 != null,
      ws.map((w) => w.id)
    )
    const opened = await callMcpIn(app, id2, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      profile: 'stub-claude',
      name: 'Accountant'
    })
    await until(() => page2.evaluate((s) => !!document.querySelector(s), rowSel(opened.sessionId)))
    await page2.click(`${rowSel(opened.sessionId)} .sidebar-item`, { button: 'right' })
    await page2.waitForTimeout(300)
    await page2.getByRole('menuitem', { name: 'Move to Ongoing' }).click()
    await page2.waitForTimeout(800)
    // Window 1 comes back to the front.
    await win.evaluate(() => window.dispatchEvent(new Event('focus')))
    await win.waitForTimeout(600)
    const has = await until(() => win.evaluate((s) => !!document.querySelector(s), SHELF))
    t.check('[setup] window 1 shows the shelf for the entry', !!has)
    await win.click(SHELF)
    await win.waitForSelector(PAGE, { timeout: 5000 })
    const status = await win.getAttribute('[data-ongoing-card]', 'data-ongoing-status')
    t.check(
      'P5a window 1 does not call a conversation running in window 2 "resting"',
      status !== 'resting',
      status
    )
    const before = starts().length
    await win.click('[data-ongoing-card]')
    await win.waitForTimeout(2500)
    const resumes = starts()
      .slice(before)
      .filter((x) => x.args.includes('--resume'))
    t.check(
      'P5b opening it from window 1 does not start a second agent on the same conversation',
      resumes.length === 0,
      resumes.map((r) => r.args.slice(0, 50))
    )
  } finally {
    await app.close()
  }
}
