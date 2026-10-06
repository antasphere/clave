/**
 * An app attached to a standalone server, before that server has a terminal
 * process (wave 2 of the split, PRDCT-3239): the sessions domain lives on the
 * server now, so the window asks the attached server for its sessions, and a
 * standalone server runs none. What this spec holds, in the built app: the
 * window SHOWS the server's own sentence where the sessions would be, on the
 * list at boot and again on a start from the launcher, never a blank chat or
 * a silent empty list (the wave's condition on publishing the attached
 * endpoint, which wave 1 had withheld for exactly that reason). Pinned
 * attached whatever the suite's mode; the same window in-process shows no
 * such notice.
 *
 * What makes it able to fail: stop publishing the attached endpoint and the
 * window lists over IPC, the notice never appears (part 1 red); have the
 * standalone host answer `[]` instead of CapabilityUnavailable and part 1
 * goes red on the boot notice; swallow the start's failure in launch-session
 * and part 2 goes red; show the notice unconditionally and part 3 goes red.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  serverEndpoint,
  until
} from './harness.mjs'
import { mkdirSync } from 'node:fs'

const ROOT = fixturePath('root-server-sessions-attached')
const WS = {
  id: 'eeeeeeee-0000-4000-8000-00000000000f',
  name: 'Attached',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const seed = (dir) => {
  seedWorkspaces(dir, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(dir, [ROOT])
}
const NOTICE = '[data-testid="server-notice"]'

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })

  // ── 1. Attached: the list says the server runs no sessions, and the window shows it ──
  {
    const DIR = userDataDir('server-sessions-attached')
    seed(DIR)
    const { app, win } = await launchApp(DIR, { server: 'attached' })
    try {
      const disc = await until(() => {
        const d = serverEndpoint(DIR)
        return d && typeof d.ok === 'boolean' ? d : null
      })
      t.equal('the app is attached to the standalone server', disc?.mode, 'attached')
      // The window is on that server: its own list call is refused with the
      // declared failure, which the preload lets through.
      // An Error crossing the context bridge keeps its message and nothing
      // else, so the page is asked for the refusal's sentence, not its tag.
      const listed = await win.evaluate(() =>
        window.electronAPI.sessionsList().then(
          (sessions) => ({ ok: true, sessions }),
          (error) => ({ ok: false, message: error?.message })
        )
      )
      t.check('the window’s list is refused', listed.ok === false, listed)
      t.check(
        'and the refusal names the missing terminal process',
        /no sessions/.test(listed.message ?? ''),
        listed
      )
      const notice = win.locator(NOTICE)
      await notice.waitFor({ timeout: 15_000 })
      const text = await notice.innerText()
      t.check(
        'the stage shows the server’s sentence where the sessions would be',
        /no sessions/.test(text),
        text
      )
      t.check('the notice is an alert', (await notice.getAttribute('role')) === 'alert')

      // ── 2. A start from the launcher is refused the same way, and the notice stays ──
      await win.locator('.launcher-split .launcher-btn').click()
      const started = await win.evaluate(() =>
        window.electronAPI.spawnSession('/tmp', { claudeMode: false }).then(
          (info) => ({ ok: true, info }),
          (error) => ({ ok: false, message: error?.message })
        )
      )
      t.check(
        'a start is refused, naming the missing terminal process',
        started.ok === false && /no sessions/.test(started.message ?? ''),
        started
      )
      t.check('the notice is still on the stage after the start', (await notice.count()) === 1)
      t.check(
        'and no tab appeared for a session that never started',
        (await win.locator('[data-sidebar-item-id]').count()) === 0
      )
    } finally {
      await app.close()
    }
  }

  // ── 3. In-process: the same window has its sessions and shows no notice ──
  {
    const DIR = userDataDir('server-sessions-in-process')
    seed(DIR)
    const { app, win } = await launchApp(DIR, { server: 'in-process' })
    try {
      const listed = await win.evaluate(() => window.electronAPI.sessionsList())
      t.check(
        'in-process, the list answers (empty, nothing open yet)',
        Array.isArray(listed),
        listed
      )
      await win.waitForTimeout(1500)
      t.check('and the stage shows no server notice', (await win.locator(NOTICE).count()) === 0)
    } finally {
      await app.close()
    }
  }
}
