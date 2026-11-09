/**
 * Ongoing conversations (PRDCT-4190): a conversation resumed after a reboot sits, hidden, in the group it came from, so Back to the sidebar returns it there (verifier round 1, F6).
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

const DIR = userDataDir('ongoing-origin')
const ROOT = fixturePath('ongoing-origin-root')
// The stub speaks at its first start, as a real tab would before it is moved: its
// transcript is what a resume needs (PRDCT-4208, F7: none means a fresh start).
const TRANSCRIPTS = `${ROOT}/transcripts`
const SPOKEN = `${TRANSCRIPTS}/stub`
const TRANSCRIPTS_ENV = { CLAVE_TRANSCRIPTS_ROOT: TRANSCRIPTS }
const BIN = `${ROOT}/bin`
const STARTS = `${ROOT}/agent-starts.jsonl`
const WS = {
  id: 'ongoing-origin-ws-0000-4000-8000-000000000011',
  name: 'ProbeOrigin',
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
  let { app, win } = await launchApp(DIR, { env: TRANSCRIPTS_ENV })
  try {
    const g = await callMcp(app, 'createGroup', { name: 'Admin' })
    const a = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      profile: 'stub-claude',
      name: 'Acc'
    })
    await callMcp(app, 'moveSession', { sessionId: a.sessionId, groupId: g.groupId })
    const sh = await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal', name: 'shell' })
    await callMcp(app, 'moveSession', { sessionId: sh.sessionId, groupId: g.groupId })
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
    await win.waitForTimeout(1200)
    await app.close()
    app = null
    await new Promise((r) => setTimeout(r, 1500))
    try {
      execFileSync('tmux', ['-L', 'clave', 'kill-session', '-t', `=${rec.tmuxName}`], {
        timeout: 10_000
      })
    } catch {
      // the tmux session may already be gone
    }
    const second = await launchApp(DIR, { env: TRANSCRIPTS_ENV, settleMs: 3000 })
    app = second.app
    win = second.win
    const l0 = await callMcp(app, 'list', {})
    t.check(
      '[setup] the group survived the restart (its shell is live)',
      l0.groups.some((x) => x.id === g.groupId),
      l0.groups.map((x) => x.name)
    )
    await until(async () => !!(await win.$(SHELF)))
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
    await win.waitForTimeout(800)
    const l1 = await callMcp(app, 'list', {})
    const grp = l1.groups.find((x) => x.id === g.groupId)
    const members = JSON.stringify(grp)
    t.check(
      'F6 the resumed (still ongoing) tab sits in its origin group',
      !!resumed && members.includes(resumed.session),
      { resumed: resumed?.session, grp }
    )
  } finally {
    if (app) await app.close()
  }
}
