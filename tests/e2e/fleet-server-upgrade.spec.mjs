// A connected server follows the Mac app's version (issue #266).
//
// One daemon reports 3.0.0-beta.6, as install-server.sh would start it from
// the v3.0.0-beta.6 tag, with a stand-in install script that only records
// its arguments and fails as a broken build would (never a real install). A Mac app launched as
// 3.0.0-beta.9 (`--test-version`, which makes a test instance behave as a
// packaged app for the version sync) connects to it. The Servers page shows
// the server's version and that it waits for idle; the daemon holds the
// upgrade while an agent works, even past the idle window, and runs the
// stand-in with exactly `--name e2e --ref v3.0.0-beta.9` only once no agent
// has worked for that window. The window is a minute in a real server;
// `--test-upgrade-idle-ms`, honoured only under `--test-no-activate`, makes
// it four seconds here. Then "Upgrade now", behind its warning, runs it again
// at once. The script fails without restarting anything, so the server stays
// up on beta.6 and reports the failure, which the open Servers row shows on
// its own within a few seconds (the server's event, routed to main): the
// fixed sentence of the code the stand-in wrote, then its exit and the log,
// and never the text it wrote beside the code.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fixturePath } from './harness.mjs'
import {
  connectMac,
  eventually,
  fleetWorld,
  openServersPage,
  request
} from './fixtures/fleet-world.mjs'

const IDLE_MS = 4_000
const APP_VERSION = '3.0.0-beta.9'
const FREE_TEXT = 'stand-in free text r1026 https://user:synthetic-secret@invalid.local/x.git'

function standIn(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const record = path.join(dir, 'calls.txt')
  const script = path.join(dir, 'install-server.sh')
  // The daemon runs a COPY under its data directory, so the record path is
  // written into the script rather than found beside it.
  writeFileSync(
    script,
    // Its failure goes where install-server.sh's own phase and fail put it: a
    // message to the log, and a phase and a code to the status file the
    // daemon names, beside free text a Mac must never be shown.
    [
      '#!/bin/bash',
      `printf '%s\\n' "$*" >> ${JSON.stringify(record)}`,
      "printf '\\033[0;31m[clave-server]\\033[0m %s\\n' 'stand-in build failed' >&2",
      `printf '%s\\n' 'phase=build' ${JSON.stringify(FREE_TEXT)} 'code=build-incomplete' ${JSON.stringify(`code=${FREE_TEXT}`)} >> "$CLAVE_INSTALL_STATUS_FILE"`,
      'exit 3',
      ''
    ].join('\n')
  )
  chmodSync(script, 0o755)
  return { script, record }
}
const calls = (record) =>
  existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean) : []

export async function run(t) {
  const { script, record } = standIn(fixturePath(`server-upgrade-${process.pid}-stand-in`))
  const world = await fleetWorld('server-upgrade', {
    count: 1,
    serverArgs: [
      '--app-version',
      '3.0.0-beta.6',
      '--install-name',
      'e2e',
      '--install-script',
      script,
      '--install-ref',
      'v3.0.0-beta.6',
      '--test-upgrade-idle-ms',
      String(IDLE_MS)
    ]
  })
  try {
    const [server] = world.servers
    const info = () => request(server, '/server/info')
    t.equal(
      'the daemon reports the version it was told, not its package.json',
      (await info()).version,
      '3.0.0-beta.6'
    )
    t.equal(
      'the daemon reports the tag it was installed from',
      (await info()).installRef,
      'v3.0.0-beta.6'
    )

    // An agent at work on the server holds the upgrade.
    const session = await request(server, '/sessions/start', {
      cwd: server.root,
      options: { claudeMode: true, launchProfileId: 'dev-echo-adapter' }
    })
    const setState = (state) =>
      server.fixture.evaluate(
        ({ id, state }) =>
          globalThis.__claveE2E.echo.inject(id, {
            kind: 'event',
            event: { type: 'state_change', state }
          }),
        { id: session.id, state }
      )
    await setState('working')
    await eventually(
      async () => (await request(server, `/sessions/by-id?id=${session.id}`)).state === 'working',
      'the server session is working'
    )

    const mac = await world.mac('a', { args: [`--test-version=${APP_VERSION}`] })
    await connectMac(mac, world.servers)
    const [owner] = mac.owners
    await eventually(async () => {
      const upgrade = (await info()).upgrade
      return upgrade.state === 'waiting-for-idle' && upgrade.target === APP_VERSION
    }, 'the Mac asked the server to upgrade to its version once idle')
    t.equal(
      'the Mac asked for exactly its own version, to wait for idle',
      (await info()).upgrade.mode,
      'when-idle'
    )

    await openServersPage(mac.win)
    const row = mac.win.locator(`[data-server-id="${owner.id}"]`)
    const version = row.locator('[data-server-version]')
    await eventually(
      async () => (await version.locator('[data-server-version-state]').count()) === 1,
      'the server row shows its version line'
    )
    t.equal(
      'the Servers page shows the server version',
      (await version.locator('[data-server-version-number]').innerText()).trim(),
      'Version 3.0.0-beta.6 ·'
    )
    t.equal(
      'the Servers page shows the upgrade waiting for idle',
      await version.locator('[data-server-version-state]').innerText(),
      `Upgrading to ${APP_VERSION} once no agent is working`
    )

    await new Promise((resolve) => setTimeout(resolve, IDLE_MS + 2_000))
    t.equal('nothing runs while an agent works, even past the idle window', calls(record).length, 0)
    t.equal('the server still waits for idle', (await info()).upgrade.state, 'waiting-for-idle')

    await setState('idle')
    const idleAt = Date.now()
    await eventually(
      async () => calls(record).length === 1,
      'the install script runs once the agents are idle'
    )
    const waited = Date.now() - idleAt
    t.check('the script ran only after a full idle window', waited >= IDLE_MS - 250, `${waited} ms`)
    t.equal(
      'the script got exactly the name and the release tag of the app version',
      calls(record)[0],
      `--name e2e --ref v${APP_VERSION}`
    )
    const log = path.join(server.dataDir, 'upgrade', 'upgrade.log')
    t.check(
      'the run was logged under the data directory',
      existsSync(log) && readFileSync(log, 'utf8').includes(`--ref v${APP_VERSION}`)
    )

    // The script failed with the server still up on beta.6: the open row
    // follows on its own (no refresh asked), and offers Upgrade now, which
    // warns before it runs anything.
    await eventually(
      async () => (await info()).upgrade.state === 'failed',
      'the server reports the failed run'
    )
    const failedAt = Date.now()
    t.equal(
      'the server keeps serving after a failed upgrade',
      (await info()).version,
      '3.0.0-beta.6'
    )
    const state = version.locator('[data-server-version-state]')
    const failedText = `Upgrade to ${APP_VERSION} failed:`
    let shown = false
    for (let i = 0; i < 50 && !shown; i++) {
      shown = (await state.innerText()).startsWith(failedText)
      if (!shown) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    t.check(
      'the open Servers row shows the failure within a few seconds, with no refresh asked',
      shown,
      `${Date.now() - failedAt} ms: ${await state.innerText()}`
    )
    t.equal(
      "the failure is the fixed sentence of the script's code, then its exit and where the log is",
      await state.innerText(),
      `Upgrade to ${APP_VERSION} failed: The build of ${APP_VERSION} did not produce the server.\nExit 3. Full log on the server: ${log}`
    )
    t.check(
      'nothing the script wrote beside its code reaches the server or the page',
      !JSON.stringify(await info()).includes('r1026') && !(await row.innerText()).includes('r1026'),
      JSON.stringify((await info()).upgrade)
    )
    const upgradeNow = version.getByRole('button', { name: 'Upgrade now', exact: true })
    await eventually(async () => (await upgradeNow.count()) === 1, 'Upgrade now is offered')
    await upgradeNow.click()
    t.check(
      'Upgrade now warns that running sessions end',
      await row
        .getByText(
          'Upgrading restarts the server: its running sessions end and come back as ended tabs to Resume.',
          { exact: true }
        )
        .isVisible()
    )
    t.equal('nothing runs before the confirmation', calls(record).length, 1)
    await setState('working')
    await row.getByRole('button', { name: 'Upgrade now', exact: true }).last().click()
    await eventually(async () => calls(record).length === 2, 'Upgrade now runs the script at once')
    t.equal(
      'Upgrade now runs the same tag, without waiting for idle',
      calls(record)[1],
      `--name e2e --ref v${APP_VERSION}`
    )

    t.equal('no page error', mac.errors.join('\n'), '')
  } finally {
    await world.close()
  }
}
