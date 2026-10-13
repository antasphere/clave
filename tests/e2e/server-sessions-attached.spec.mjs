/**
 * An app attached to a standalone server runs its sessions THERE (wave 3 of
 * the split, PRDCT-3293): the server hosts the app's own session host over
 * its terminal process, so a window on an attached app lists its sessions
 * from the server, starts a terminal from the launcher that the server's
 * terminal process runs, sees its output arrive off the push channel, writes
 * to it over the server, and stops it. Wave 2 held the opposite here (the
 * server's refusal shown on the stage); the notice must now never appear.
 * Pinned attached whatever the suite's mode; part 3 keeps the in-process
 * window on the same checks.
 *
 * What makes it able to fail: run the standalone entry on `SessionHost.none`
 * again and part 1 goes red on the list and the notice; leave the resize
 * command off the server road and the terminal never starts (no prompt, no
 * echo); route the pane's bytes over IPC on an attached app and the echo
 * never comes back; drop the terminal journal from the server's data folder
 * and the spawn check goes red.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  serverEndpoint,
  spawnJournal,
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

/** The text xterm shows: one terminal is open in each part, so the page's
 *  one pane is it (read as textContent: the window is never shown). */
const paneText = (win) =>
  win.evaluate(() =>
    [...document.querySelectorAll('.xterm-rows')].map((el) => el.textContent ?? '').join('\n')
  )

async function terminalRoundTrip(t, { win, dir, label }) {
  const spawns = spawnJournal(dir)
  // The launcher's row button starts a plain terminal at the workspace root:
  // the one session kind that needs no provider installed.
  await win.click('.launcher-row button')
  const session = await until(async () => {
    const all = await win.evaluate(() => window.electronAPI.sessionsList())
    return all.find((s) => s.provider === 'terminal') ?? null
  })
  t.check(`${label}: a terminal started from the launcher is listed`, !!session, session)
  if (!session) return
  await win.waitForSelector(`[data-sidebar-item-id="${session.id}"]`, { timeout: 10_000 })
  t.check(`${label}: and has its tab`, true)
  const journaled = await until(async () => {
    const seen = await spawns()
    return seen.find((s) => s.cwd === ROOT) ?? null
  })
  t.check(
    `${label}: the terminal manager journaled the spawn at the workspace root`,
    !!journaled,
    journaled
  )
  // The process is started at the pane's real size (the resize road) and its
  // first bytes reach xterm: a shell prompt, or anything at all on the rows.
  const prompted = await until(async () => ((await paneText(win)).trim() ? true : null), {
    tries: 80,
    gapMs: 250
  })
  t.check(`${label}: the terminal's output reaches the pane`, prompted === true)
  // A line typed into the pane comes back echoed by the shell: the bytes
  // went out over the same road the output came in on.
  const marker = `attached-round-trip-${process.pid}`
  await win.evaluate(({ id, text }) => window.electronAPI.writeSession(id, `echo ${text}\r`), {
    id: session.id,
    text: marker
  })
  const echoed = await until(async () => ((await paneText(win)).includes(marker) ? true : null), {
    tries: 80,
    gapMs: 250
  })
  t.check(`${label}: a line written to the terminal is echoed back`, echoed === true)
  await win.evaluate((id) => window.electronAPI.killSession(id), session.id)
  const gone = await until(async () => {
    const all = await win.evaluate(() => window.electronAPI.sessionsList())
    return all.some((s) => s.id === session.id) ? null : true
  })
  t.check(`${label}: stopped, the session is gone from the list`, gone === true)
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })

  // ── 1. Attached: the sessions live on the standalone server ──
  {
    const DIR = userDataDir('server-sessions-attached')
    seed(DIR)
    const { app, win, server } = await launchApp(DIR, { server: 'attached' })
    try {
      const disc = await until(() => {
        const d = serverEndpoint(DIR)
        return d && typeof d.ok === 'boolean' ? d : null
      })
      t.equal('the app is attached to the standalone server', disc?.mode, 'attached')
      t.check('and the harness started a server with a data folder of its own', !!server?.dataDir)
      const listed = await win.evaluate(() =>
        window.electronAPI.sessionsList().then(
          (sessions) => ({ ok: true, sessions }),
          (error) => ({ ok: false, message: error?.message })
        )
      )
      t.check(
        'the window’s list answers from the server (empty, nothing open yet)',
        listed.ok,
        listed
      )
      await win.waitForTimeout(1500)
      t.check('and the stage shows no server notice', (await win.locator(NOTICE).count()) === 0)
      await terminalRoundTrip(t, { win, dir: DIR, label: 'attached' })
      t.check('no server notice appeared along the way', (await win.locator(NOTICE).count()) === 0)
    } finally {
      await app.close()
    }
  }

  // ── 2. In-process: the same window, the same round trip ──
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
      await terminalRoundTrip(t, { win, dir: DIR, label: 'in-process' })
    } finally {
      await app.close()
    }
  }
}
