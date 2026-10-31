// A window keeps the pins it just loaded when it reaches the server late
// (wave 5, lane A, PRDCT-3405). The push socket's welcome reads the server's
// copy of the workspace state and hands it to the window's fold; a copy read
// BEFORE the window wrote its pins and answered AFTER reset them, since the
// fold replaced the pins by content whatever the copy's age. The state now
// carries a stamp (a revision in the process holding it, and that process's
// id), and the window drops a fold that is not newer than the last stamp it
// loaded, wrote or took in.
//
// The race, made deterministic: main names the server late (the harness's
// boot-delay seam), so the welcome comes well after the boot refresh loaded
// the two groups of the profile file; the settings source's `load`, the
// read the catch-up makes, is wrapped in the process holding the settings to
// answer its first call four seconds late with the copy taken at call time;
// in that window the profile file is edited on disk (a group renamed, one
// added), which the window takes in through its file watcher and writes.
// The late answer is older than that write: the window must keep the three
// groups. On the old code the fold put the stale copy back (in-process the
// two old names; attached the server's seeded empty list), the picker showed
// it, and the next write of the partition would have carried it to disk.
//
// Both modes: in-process the wrapped source is main's own; attached it is the
// standalone server's, whose copy the window never wrote to before the
// welcome (its boot writes went to main over IPC), so the late answer comes
// from another instance, which the window adopts while keeping its pins and
// writing them there.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  serverEndpoint,
  userDataDir,
  fixturePath,
  until,
  serverMode
} from './harness.mjs'

const DIR = userDataDir('workspace-pins-late-catch-up')
const ROOT = fixturePath('workspace-pins-late-catch-up-root')
const CLAVE = `${ROOT}/lanes.clave`
const WS = {
  id: 'pins-late-ws',
  name: 'Pins',
  rootDir: ROOT,
  profileFile: CLAVE,
  createdAt: 1
}
const BOOT_DELAY_MS = 6000
const READ_DELAY_MS = 4000

const profile = (names) =>
  JSON.stringify(
    {
      $schema: 'clave/1.0',
      groups: names.map((name) => ({
        name,
        cwd: '.',
        color: 'teal',
        sessions: [{ cwd: '.', name: 'seed', claudeMode: false }]
      }))
    },
    null,
    2
  )

/** Runs in the process holding the settings (main in-process, the standalone
 *  server attached): the first `load` after this answers `delayMs` late with
 *  the copy taken when it was called, and says when it was read and answered. */
function installLateRead(delayMs) {
  const hooks = globalThis.__claveE2E
  if (!hooks?.settings) throw new Error('no settings source: is --test-no-activate on?')
  const probe = (globalThis.__lateRead = { reads: 0, readAt: null, answeredAt: null, pins: null })
  const real = hooks.settings.workspaces.load
  hooks.settings.workspaces.load = async () => {
    const state = JSON.parse(JSON.stringify(await real()))
    probe.reads += 1
    if (probe.reads > 1) return state
    probe.readAt = Date.now()
    probe.pins = state.pins.map((p) => p.name)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    probe.answeredAt = Date.now()
    return state
  }
  return true
}
const readLateRead = () => globalThis.__lateRead ?? null

/** The names on the group picker's cards, opened and closed again. */
async function pickerNames(win) {
  await win.click('button[aria-label="Add a group"]')
  await win.waitForTimeout(400)
  const names = await win.evaluate(() =>
    [...document.querySelectorAll('.group-picker-card')].map((c) => c.getAttribute('title'))
  )
  await win.keyboard.press('Escape')
  await win.waitForTimeout(200)
  return names.sort().join(' | ')
}

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(CLAVE, profile(['Alpha lane', 'Bravo lane']))
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  // Separate mode runs this spec attached: its probe is installed in the
  // process that holds the settings before main names the server, and a
  // separate server is the app's own child, started only after the delay,
  // so there is no such process to install it in yet. A server in another
  // process is what attached mode already covers for this subject.
  const mode = serverMode() === 'separate' ? 'attached' : serverMode()
  const { app, win, server, fixture } = await launchApp(DIR, {
    server: mode,
    env: { CLAVE_E2E_SERVER_BOOT_DELAY_MS: String(BOOT_DELAY_MS) }
  })
  try {
    // Where the settings live: the server's process attached (reachable from
    // the start, the harness started it), main's own in-process. In-process
    // the fixture route is reachable only once main names the server, which
    // is what this spec delays, so the probe is installed through the app
    // itself; it is read through the fixture in both modes, since by the
    // time there is anything to read the server is named.
    const installed = server
      ? await fixture.evaluate(installLateRead, READ_DELAY_MS)
      : await app.evaluate(
          (_electron, { source, arg }) => new Function(`return (${source})`)()(arg),
          { source: installLateRead.toString(), arg: READ_DELAY_MS }
        )
    const probe = () => fixture.evaluate(readLateRead).catch(() => null)

    t.check(
      'the window booted before main named the server',
      serverEndpoint(DIR) === null,
      serverEndpoint(DIR)
    )
    t.equal(
      'the boot refresh loaded the two groups of the profile file',
      await pickerNames(win),
      'Alpha lane | Bravo lane'
    )
    t.check('the late read is installed', installed === true, installed)

    // The server is named, the socket welcomed, the catch-up read goes out.
    const read = await until(
      async () => {
        const p = await probe()
        return p?.readAt ? p : null
      },
      { tries: (BOOT_DELAY_MS + 12_000) / 250, gapMs: 250 }
    )
    t.check('the welcome read the server’s copy of the state', read !== null, read)
    if (!read) return

    // The window writes while the read is out: the profile file changes.
    const editedAt = Date.now()
    writeFileSync(CLAVE, profile(['Alpha renamed', 'Bravo lane', 'Charlie lane']))
    const written = await until(
      async () => {
        const names = await pickerNames(win)
        return names === 'Alpha renamed | Bravo lane | Charlie lane' ? names : null
      },
      { tries: 12, gapMs: 250 }
    )
    t.equal(
      'the window took the edit in before the read answered',
      written,
      'Alpha renamed | Bravo lane | Charlie lane'
    )
    const answered = await until(
      async () => {
        const p = await probe()
        return p?.answeredAt ? p : null
      },
      { tries: (READ_DELAY_MS + 4000) / 250, gapMs: 250 }
    )
    t.check('the read answered, after the edit', answered?.answeredAt > editedAt, answered)
    t.check('and it was read before the edit', read.readAt < editedAt, { read, editedAt })
    await win.waitForTimeout(1000)

    t.equal(
      'the window keeps the three groups: the late copy did not fold over them',
      await pickerNames(win),
      'Alpha renamed | Bravo lane | Charlie lane'
    )
    const persisted = await win.evaluate(() => window.electronAPI.workspaceLoad())
    t.equal(
      'and the state the window writes to holds the three',
      persisted.pins
        .map((p) => p.name)
        .sort()
        .join(' | '),
      'Alpha renamed | Bravo lane | Charlie lane'
    )
    t.check(
      'the state carries its stamp',
      typeof persisted.revision === 'number' && typeof persisted.instance === 'string',
      { revision: persisted.revision, instance: persisted.instance }
    )
  } finally {
    await app.close()
  }
}
