// Another Mac's upgrade, seen from a Mac on the server's own version (issue
// #266, V2-F2). A daemon on 3.0.0-beta.9 is asked by a newer client for
// beta.10 once idle, while an agent works. A Mac on beta.9 connects: its
// Servers row shows that wait with its target, then, with no refresh asked,
// the run the newer client starts now. It offers no "Upgrade now" of its own
// and never asks anything: the server's target stays beta.10 (an ask for the
// version it runs would have cancelled the wait). The stand-in install script
// sleeps, then exits 0 without installing anything.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fixturePath } from './harness.mjs'
import {
  connectMac,
  eventually,
  fleetWorld,
  openServersPage,
  request
} from './fixtures/fleet-world.mjs'

const ELSEWHERE = '3.0.0-beta.10'

export async function run(t) {
  const dir = fixturePath(`server-upgrade-elsewhere-${process.pid}-stand-in`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const script = path.join(dir, 'install-server.sh')
  writeFileSync(script, '#!/bin/bash\nsleep 4\nexit 0\n')
  chmodSync(script, 0o755)
  const world = await fleetWorld('server-upgrade-elsewhere', {
    count: 1,
    serverArgs: [
      '--app-version',
      '3.0.0-beta.9',
      '--install-name',
      'e2e',
      '--install-script',
      script,
      '--install-ref',
      'v3.0.0-beta.9'
    ]
  })
  try {
    const [server] = world.servers
    const info = () => request(server, '/server/info')
    const session = await request(server, '/sessions/start', {
      cwd: server.root,
      options: { claudeMode: true, launchProfileId: 'dev-echo-adapter' }
    })
    await server.fixture.evaluate(
      (id) =>
        globalThis.__claveE2E.echo.inject(id, {
          kind: 'event',
          event: { type: 'state_change', state: 'working' }
        }),
      session.id
    )
    // What a newer Mac would ask.
    await request(server, '/server/upgrade', { version: ELSEWHERE, when: 'idle' })

    const mac = await world.mac('beta9', { args: ['--test-version=3.0.0-beta.9'] })
    await connectMac(mac, world.servers)
    await openServersPage(mac.win)
    const row = mac.win.locator(`[data-server-id="${mac.owners[0].id}"]`)
    const state = row.locator('[data-server-version-state]')
    await eventually(
      async () =>
        (await state.count()) === 1 &&
        (await state.innerText()) === `Upgrading to ${ELSEWHERE} once no agent is working`,
      "the row shows the other Mac's pending upgrade"
    )
    t.equal(
      "a Mac on the server's version shows the pending upgrade with its target",
      await state.innerText(),
      `Upgrading to ${ELSEWHERE} once no agent is working`
    )
    t.equal(
      'it offers no Upgrade now of its own',
      await row.getByRole('button', { name: 'Upgrade now', exact: true }).count(),
      0
    )
    t.equal(
      'it never asked: the server still waits for beta.10',
      (await info()).upgrade.target,
      ELSEWHERE
    )
    t.equal('the server still waits for idle', (await info()).upgrade.state, 'waiting-for-idle')

    // The newer client starts it now: the row follows, nothing refreshed.
    await request(server, '/server/upgrade', { version: ELSEWHERE, when: 'now' })
    await eventually(
      async () => (await state.innerText()) === `Upgrading to ${ELSEWHERE}…`,
      'the row follows the run on its own'
    )
    t.equal(
      'the row shows the running upgrade',
      await state.innerText(),
      `Upgrading to ${ELSEWHERE}…`
    )
    t.equal('the stand-in is running on the server', (await info()).upgrade.state, 'running')
    t.equal(
      'still no Upgrade now while it runs',
      await row.getByRole('button', { name: 'Upgrade now', exact: true }).count(),
      0
    )
    await eventually(async () => (await info()).upgrade.state === 'idle', 'the stand-in finished')
    await eventually(
      async () => (await state.innerText()) === 'Same version as this app',
      'the row comes back to the plain answer'
    )
    t.equal(
      'back to the same version once it ended',
      await state.innerText(),
      'Same version as this app'
    )
    t.equal('no page error', mac.errors.join('\n'), '')
  } finally {
    await world.close()
  }
}
