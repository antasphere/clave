// The harness waits on the window's boot, not on a clock (PRDCT-1762).
//
// The renderer's boot restore replaces the window's layout with the saved
// one at the end of its own boot, so a group created before that point was
// wiped: measured on 5 October under load, a group created 2 s after the
// page loaded was never drawn, one created at 3 s was, and four specs sat
// in known-failures.json for it. `launchApp` now returns once the document
// carries `data-boot="complete"`; this spec passes `settleMs: 0` so that
// the mark is the ONLY thing between the page load and the first command.
// On the old harness, settleMs 0 put the group before the merge and lost it.
import { mkdirSync } from 'node:fs'
import {
  callMcp,
  fixturePath,
  launchApp,
  seedTrustedRoots,
  seedWorkspaces,
  userDataDir
} from './harness.mjs'

const DIR = userDataDir('clave-e2e-boot-ready')
const ROOT = fixturePath('boot-ready-root')
const WS = { id: 'ws-boot-ready', name: 'Boot ready', rootPath: ROOT }

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const launchedAt = Date.now()
  const { app, win } = await launchApp(DIR, { settleMs: 0 })
  try {
    const mark = await win.evaluate(() => document.documentElement.dataset.boot ?? null)
    t.equal('the window carries the boot mark when launchApp returns', mark, 'complete')

    // The first command the moment the launch returns: what the unstable
    // specs did at 4 s and lost under load.
    const group = await callMcp(app, 'createGroup', { name: 'Right after boot' })
    await win.waitForTimeout(1500)
    const listed = await callMcp(app, 'list', {})
    t.check(
      'a group created the moment launchApp returns is still listed 1.5 s later',
      listed.groups.some((g) => g.id === group.groupId),
      { created: group.groupId, groups: listed.groups.map((g) => g.id) }
    )
    const drawn = await win.evaluate(() =>
      (document.body.textContent || '').includes('Right after boot')
    )
    t.check('and it is drawn in the sidebar', drawn)

    // The launch took what the boot took, never a fixed four seconds on top:
    // the figure is printed so a run under load can be read.
    const took = Date.now() - launchedAt
    t.check(
      `the launch returned on the boot (${took} ms), within the boot timeout`,
      took < 60_000,
      took
    )
  } finally {
    await app.close()
  }
}
