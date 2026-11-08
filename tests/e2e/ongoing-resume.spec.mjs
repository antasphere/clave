/**
 * Ongoing conversations (PRDCT-4190): a dead tab replaced by its resume leaves no record behind, which the next boot would read as a second, older launch of the conversation (verifier round 2, R2-F3).
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

const DIR = userDataDir('ongoing-resume')
const ROOT = fixturePath('ongoing-resume-root')
const BIN = `${ROOT}/bin`
const STARTS = `${ROOT}/agent-starts.jsonl`
const WS = {
  id: 'ongoing-resume-ws-0000-4000-8000-000000000010',
  name: 'ProbeLeak',
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

export async function run(t) {
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
  const { app, win } = await launchApp(DIR)
  try {
    const a = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      profile: 'stub-claude',
      name: 'Acc'
    })
    await until(() => win.evaluate((s) => !!document.querySelector(s), rowSel(a.sessionId)))
    const rec = (
      await win.evaluate(
        async (i) => await window.electronAPI.listSessionRecords({ ids: [i] }),
        a.sessionId
      )
    )[0]
    await win.click(`${rowSel(a.sessionId)} .sidebar-item`, { button: 'right' })
    await win.waitForTimeout(300)
    await win.getByRole('menuitem', { name: 'Move to Ongoing' }).click()
    await win.waitForTimeout(800)
    // The tab's process ends while the app runs.
    try {
      execFileSync('tmux', ['-L', 'clave', 'kill-session', '-t', `=${rec.tmuxName}`], {
        timeout: 10_000
      })
    } catch {}
    const dead = await until(async () => {
      const l = await callMcp(app, 'list', {})
      const s = l.sessions.find((x) => x.id === a.sessionId)
      return s && s.alive === false ? true : null
    })
    t.check('[setup] the tab is dead in the store', !!dead)
    await win.click(SHELF)
    await win.waitForSelector(PAGE)
    const before = starts().length
    await win.click('[data-ongoing-card]')
    const resumed = await until(
      () =>
        starts()
          .slice(before)
          .find((x) => x.args.includes('--resume')) ?? null
    )
    t.check(
      '[setup] resumed in a new tab',
      !!resumed && resumed.session !== a.sessionId,
      resumed?.session
    )
    await win.waitForTimeout(1000)
    const left = await win.evaluate(
      async (i) =>
        (await window.electronAPI.listSessionRecords({ ids: [i] })).map((r) => ({
          id: r.id,
          live: r.live
        })),
      a.sessionId
    )
    t.check(
      'N4 the replaced dead tab leaves no record behind (it would be a second record of the conversation at the next boot)',
      left.length === 0,
      left
    )
  } finally {
    await app.close()
  }
}
