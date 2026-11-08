/**
 * Ongoing conversations (PRDCT-4190): a note being written is discarded on Escape, which leaves the page open.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

const DIR = userDataDir('ongoing-note')
const ROOT = fixturePath('ongoing-note-root')
const BIN = `${ROOT}/bin`
const WS = {
  id: 'ongoing-note-ws-0000-4000-8000-00000000000d',
  name: 'ProbeNote',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const rowSel = (id) => `[data-sidebar-item-id="${id}"]`
const SHELF = '[data-ongoing-shelf]'
const PAGE = '[data-ongoing-page]'

export async function run(t) {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(`${BIN}/claude`, '#!/bin/sh\nexec sleep 600\n', { mode: 0o755 })
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
  const { app, win } = await launchApp(DIR)
  try {
    const a = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      profile: 'stub-claude',
      name: 'Acc'
    })
    await until(() => win.evaluate((s) => !!document.querySelector(s), rowSel(a.sessionId)))
    await win.click(`${rowSel(a.sessionId)} .sidebar-item`, { button: 'right' })
    await win.waitForTimeout(300)
    await win.getByRole('menuitem', { name: 'Move to Ongoing' }).click()
    await win.waitForTimeout(600)
    await win.click(SHELF)
    await win.waitForSelector(PAGE)
    await win.click('.ongoing-note')
    await win.fill('.ongoing-note-input', 'first')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(400)
    await win.click('.ongoing-note')
    await win.fill('.ongoing-note-input', 'should be discarded')
    await win.keyboard.press('Escape')
    await win.waitForTimeout(500)
    const note = (await win.textContent('.ongoing-note'))?.trim()
    t.check('P6 Escape while editing discards the draft', note === 'first', note)
    const page = await win.evaluate((s) => !!document.querySelector(s), PAGE)
    t.check('P6b Escape in the note input does not leave the page', page)
  } finally {
    await app.close()
  }
}
