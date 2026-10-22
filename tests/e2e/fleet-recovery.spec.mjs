import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO } from './harness.mjs'
import { fleetWorld, connectMac, eventually, owned, request } from './fixtures/fleet-world.mjs'

export async function run(t) {
  const world = await fleetWorld('recovery')
  try {
    const report = world.load()
    const [a, b] = world.servers
    // Echo deliberately has no restart record. Use the real Codex adapter
    // with a local stdio recording provider for the persisted chat path.
    await request(a, '/launch-profiles', {
      profile: {
        id: 'fleet-recovery-provider',
        name: 'Fleet recovery recording provider',
        family: 'codex',
        command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/fleet-provider.mjs')],
        additionalArgs: ['--fleet-history']
      }
    })
    const recorded = await request(a, '/sessions/start', {
      cwd: a.root,
      options: {
        claudeMode: false,
        codexMode: true,
        launchProfileId: 'chat:codex:fleet-recovery-provider'
      }
    })
    await eventually(
      async () =>
        JSON.stringify(await request(a, `/sessions/history?id=${recorded.id}`)).includes(
          'Durable recovery recording provider'
        ),
      'real recording adapter has live history before restart'
    )
    const macA = await world.mac('a')
    await connectMac(macA, world.servers)
    const macB = await world.mac('b')
    await macB.win.evaluate(() => {
      globalThis.fleetStates = {}
      window.electronAPI.onFleetStatus((s) => {
        globalThis.fleetStates[s.serverId] = s.state
      })
    })
    const wrong = await macB.win.evaluate(
      ({ url }) =>
        window.electronAPI.fleetSave({
          name: 'Wrong credential',
          url,
          token: 'isolated-wrong-token'
        }),
      { url: a.url }
    )
    await eventually(
      () => macB.win.evaluate((id) => globalThis.fleetStates[id] === 'unauthorized', wrong.id),
      'wrong token is reported by this owner'
    )
    await assert.rejects(macB.win.evaluate((id) => window.electronAPI.fleetSnapshot(id), wrong.id))
    const response = await fetch(a.url + '/sessions', {
      headers: { authorization: 'Bearer isolated-wrong-token' }
    })
    assert.equal(response.status, 401)
    const second = await macB.win.evaluate(
      ({ url, token }) => window.electronAPI.fleetSave({ name: 'Live second owner', url, token }),
      { url: b.url, token: b.token }
    )
    const secondKey = owned('session', second.id, report.values.second.sessionId)
    await eventually(async () => {
      try {
        return (
          await macB.win.evaluate((id) => window.electronAPI.fleetSnapshot(id), second.id)
        ).sessions.some((s) => s.id === secondKey)
      } catch {
        return false
      }
    }, 'other owner works beside rejected token')
    t.check('wrong token refuses only its owner while the other server remains usable', true)
    await macB.win.evaluate(
      ({ id, url, token }) =>
        window.electronAPI.fleetSave({ id, name: 'Corrected owner', url, token }),
      { id: wrong.id, url: a.url, token: a.token }
    )
    await eventually(
      () => macB.win.evaluate((id) => globalThis.fleetStates[id] === 'connected', wrong.id),
      'corrected saved credential connects'
    )

    const owner = macA.owners[0].id
    const terminal = await macA.win.evaluate(
      ({ owner, cwd }) =>
        window.electronAPI.fleetStart(owner, cwd, {
          claudeMode: false,
          initialCommand:
            "printf 'ONCE\\n' >> start-count.txt; while :; do printf 'TICK\\n' >> ticks.txt; printf 'TICK\\n'; sleep 1; done",
          autoExecute: true
        }),
      { owner, cwd: a.root }
    )
    const rawId = decodeURIComponent(terminal.id.split(':').at(-1))
    await macA.win.locator(`[data-sidebar-item-id="${terminal.id}"]`).click()
    await macA.win.locator(`[data-terminal-tile="${terminal.id}"] .xterm`).waitFor()
    await eventually(() => existsSync(path.join(a.root, 'ticks.txt')), 'actual remote shell starts')
    const startCount = readFileSync(path.join(a.root, 'start-count.txt'), 'utf8')
    assert.equal(startCount, 'ONCE\n')
    const before = readFileSync(path.join(a.root, 'ticks.txt'), 'utf8').length
    await macB.win.evaluate((id) => window.electronAPI.fleetDisconnect(id), wrong.id)
    await macA.close()
    await eventually(
      () => readFileSync(path.join(a.root, 'ticks.txt'), 'utf8').length > before,
      'shell executes while both clients are detached'
    )
    assert.ok((await request(a, '/sessions')).some((s) => s.id === rawId))
    t.check(
      'real remote shell continues producing owner-side effects after the first Mac quits and the second detaches',
      true
    )

    const serverId = a.serverId
    const token = a.token
    const url = a.url
    await world.restart(0)
    assert.equal(a.serverId, serverId)
    assert.ok(a.token === token, 'saved daemon credential is unchanged')
    assert.equal(a.url, url)
    assert.equal((await request(a, '/sessions')).find((s) => s.id === rawId)?.state, 'ended')
    assert.equal(readFileSync(path.join(a.root, 'start-count.txt'), 'utf8'), startCount)
    await macB.win.evaluate((id) => window.electronAPI.fleetConnect(id), wrong.id)
    const key = owned('session', wrong.id, rawId)
    await macB.win.locator(`[data-sidebar-item-id="${key}"]`).waitFor()
    await macB.win.locator(`[data-sidebar-item-id="${key}"]`).click()
    const resume = macB.win
      .locator(`[data-terminal-tile="${key}"]`)
      .getByRole('button', { name: 'Resume', exact: true })
    await resume.waitFor()
    assert.equal(
      (await request(a, '/sessions')).find((s) => s.id === rawId)?.state,
      'ended',
      'selecting recovered tab does not start the process'
    )
    assert.equal(readFileSync(path.join(a.root, 'start-count.txt'), 'utf8'), startCount)
    const recoveredHistory = await macB.win.evaluate(
      (id) => window.electronAPI.sessionsHistory(id),
      owned('session', wrong.id, recorded.id)
    )
    assert.ok(JSON.stringify(recoveredHistory).includes('Durable recovery recording provider'))
    t.check(
      'daemon restart preserves identity and history but restores the interrupted shell stopped with explicit Resume',
      true
    )

    await resume.click()
    await eventually(
      async () =>
        (await request(a, '/sessions')).some((s) => s.id === rawId && s.state !== 'ended'),
      'explicit Resume starts a fresh process'
    )
    await macB.win.evaluate(
      (id) => window.electronAPI.writeSession(id, "printf 'RESUMED\\n' > resumed.txt\r"),
      key
    )
    await eventually(
      () => existsSync(path.join(a.root, 'resumed.txt')),
      'resumed shell accepts a new deliberate command'
    )
    assert.equal(readFileSync(path.join(a.root, 'resumed.txt'), 'utf8'), 'RESUMED\n')
    assert.equal(
      readFileSync(path.join(a.root, 'start-count.txt'), 'utf8'),
      startCount,
      'Resume must never replay the interrupted initial command'
    )
    assert.equal(existsSync(path.join(b.root, 'resumed.txt')), false)
    assert.deepEqual(macB.errors, [])
    t.check(
      'explicit Resume runs a new command on its owner without replaying the interrupted command',
      true
    )
  } finally {
    await world.close()
  }
}
