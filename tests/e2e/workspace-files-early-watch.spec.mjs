// A `.clave` watched by a window that booted BEFORE main named the server
// still reaches that window once the server is up (wave 3, lane A,
// PRDCT-3291, the verifier's round 5 on the real app). The window's watch
// is taken over IPC while there is no server, moved to the server by the
// preload's ledger once there is one, and the change listener bound at
// start must then hear the push channel: in-process the shared instance's
// IPC fan-out hid a listener that never bound its push side; attached
// nothing did, and the hot reload was lost for good. Runs in both modes;
// the server comes late through the harness's boot-delay seam.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  serverEndpoint,
  userDataDir,
  fixturePath,
  until
} from './harness.mjs'

const DIR = userDataDir('workspace-files-early-watch')
const ROOT = fixturePath('wsf-early-root')
const FILE = `${ROOT}/early.clave`
const WS = { id: 'wsf-early-ws', name: 'Early', rootDir: ROOT, profileFile: null, createdAt: 1 }
const BOOT_DELAY_MS = 8000

const clave = (name) =>
  JSON.stringify({ $schema: 'clave/1.0', name, cwd: '.', sessions: [], terminals: [] })

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(FILE, clave('Before'))
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  // The server comes 8 s after boot; the window is driven 1.5 s after load.
  const { app, win } = await launchApp(DIR, {
    settleMs: 1500,
    env: { CLAVE_E2E_SERVER_BOOT_DELAY_MS: String(BOOT_DELAY_MS) }
  })
  try {
    // The discovery file is written once the shell has its server: absent now.
    const endpointNow = serverEndpoint(DIR)
    t.check('the window is driven before main named the server', endpointNow === null, endpointNow)

    await win.evaluate(async (file) => {
      window.__earlyChanges = []
      window.__earlyOff = window.electronAPI.onClaveFileChanged((p) =>
        window.__earlyChanges.push(p)
      )
      await window.electronAPI.watchClaveFile(file)
    }, FILE)
    await win.waitForTimeout(500)
    writeFileSync(FILE, clave('Edited on IPC'))
    const onIpc = await until(
      async () => {
        const c = await win.evaluate(() => window.__earlyChanges)
        return c.length > 0 ? c : null
      },
      { tries: 40, gapMs: 250 }
    )
    t.check(
      'an edit before the server reaches the window over IPC',
      Array.isArray(onIpc) && onIpc.length === 1,
      onIpc
    )

    // The server comes up and the watch moves to it; the edit after must still arrive.
    await win.waitForTimeout(BOOT_DELAY_MS + 4000)
    writeFileSync(FILE, clave('Edited after the hand-over'))
    const after = await until(
      async () => {
        const c = await win.evaluate(() => window.__earlyChanges)
        return c.length > 1 ? c : null
      },
      { tries: 40, gapMs: 250 }
    )
    t.check(
      'an edit after the server came up reaches the listener bound before it',
      Array.isArray(after) && after.length === 2,
      after
    )
    await win.waitForTimeout(1500)
    const all = await win.evaluate(() => window.__earlyChanges)
    t.equal('and exactly once', all.length, 2)
    await win.evaluate(async (file) => {
      await window.electronAPI.unwatchClaveFile(file)
      window.__earlyOff()
    }, FILE)
  } finally {
    await app.close()
  }
}
