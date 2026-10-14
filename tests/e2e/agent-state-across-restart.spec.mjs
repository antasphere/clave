// Runs in BOTH modes (wave 5, lane B, PRDCT-3289). A Claude tab whose agent is
// working when the app quits shows the working state at once when the next
// launch brings the tab back, with the hook's word unchanged meanwhile. Before:
// the window built the tab from its record with no state, and the hook watcher
// forwards a word once per change, so the tab read idle until the agent's next
// transition; and the process that takes a session back was born idle too, so
// the window had nothing to read even where it looked.
//
// The agent is a stand-in launch profile (a shell that sleeps) in the claude
// family, so the tab has a lifecycle state Clave trusts; the hook's word is
// written by hand into the agent-state folder of the process that runs the
// session (the app's folder in-process, the server's attached), the way the
// real hooks write it. Nothing writes it again after the quit.
//
// What makes it able to fail: take the seed out of the spawn (pty-manager.ts,
// `reattached`) and the relaunched tab reads idle in both modes; take the
// renderer's seed out (adopt-record.ts, seedAgentStatesFromKernel) and the
// kernel says working while the row stays idle.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  recordsRootOf,
  userDataDir,
  fixturePath,
  callMcp,
  until,
  killLeakedE2eTmux
} from './harness.mjs'

const DIR = userDataDir('agent-state-restart')
const ROOT = fixturePath('root-agent-state-restart')
const WS = {
  id: 'aaaaaaaa-0000-4000-8000-0000000000c5',
  name: 'Working',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

/** The row's one signal, as `lib/tab-status.ts` paints it (`data-status`). */
const rowStatus = (win, id) =>
  win.evaluate(
    (sid) =>
      document
        .querySelector(`[data-sidebar-item-id="${sid}"] .tab-status`)
        ?.getAttribute('data-status') ?? null,
    id
  )

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  killLeakedE2eTmux()

  let app = null
  let id = null
  try {
    const first = await launchApp(DIR)
    app = first.app
    // A claude-family profile whose command is a shell that sleeps: the tab
    // has a lifecycle state Clave trusts, and no real agent runs.
    await first.win.evaluate(async (workspaceId) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'e2e-claude-sleeper',
        name: 'sleeper',
        family: 'claude',
        command: ['sh', '-c', 'sleep 600', 'claude'],
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetWorkspace(
        workspaceId,
        'claude',
        'e2e-claude-sleeper'
      )
    }, WS.id)
    id = (await callMcp(app, 'openSession', { cwd: ROOT, mode: 'claude' })).sessionId
    const alive = await until(async () =>
      (await callMcp(app, 'list', {})).sessions.find((s) => s.id === id && s.alive)
    )
    t.check('a claude-family tab is open and alive', !!alive, id)
    t.equal('and reads idle before any hook word', await rowStatus(first.win, id), 'idle')

    // The hooks' word, written where the process running the session reads
    // it. Written once; nothing writes it again after the quit.
    const stateDir = path.join(recordsRootOf(DIR), 'agent-state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(path.join(stateDir, `${id}.state`), 'working')
    await new Promise((r) => setTimeout(r, 800))
    await app.close()
    app = null

    const second = await launchApp(DIR, { settleMs: 1500 })
    app = second.app
    const back = await until(async () =>
      (await callMcp(app, 'list', {})).sessions.find((s) => s.id === id && s.alive)
    )
    t.check('the next launch brings the tab back, same id, alive', !!back, id)
    const kernel = await until(async () => {
      const listed = await callMcp(app, 'list', {})
      const s = listed.sessions.find((x) => x.id === id)
      return s?.agentState === 'working' ? s : null
    })
    t.check(
      'the process that took the session back holds the working word (the seed on spawn)',
      !!kernel,
      (await callMcp(app, 'list', {})).sessions.find((x) => x.id === id)
    )
    const painted = await until(async () =>
      (await rowStatus(second.win, id)) === 'working' ? true : null
    )
    t.check(
      'and the row shows working at once, with the hook word unchanged since the quit',
      !!painted,
      await rowStatus(second.win, id)
    )
  } finally {
    if (app) {
      if (id) await callMcp(app, 'closeSession', { sessionId: id }).catch(() => {})
      await app.close().catch(() => {})
    }
    killLeakedE2eTmux()
  }
}
