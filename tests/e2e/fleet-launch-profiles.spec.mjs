import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { REPO, terminalJournalPath } from './harness.mjs'
import {
  fleetWorld,
  connectMac,
  eventually,
  request,
  ownerReady,
  clickReady,
  showServer
} from './fixtures/fleet-world.mjs'

export async function run(t) {
  const world = await fleetWorld('launch-profiles')
  try {
    world.load()
    const [a, b] = world.servers
    const mac = await world.mac('a')
    const win = mac.win
    await connectMac(mac, world.servers, { ui: false })
    const owner = mac.owners[0].id
    // A server's sessions show in that server's workspaces only (#241).
    await showServer(mac, 0)
    const profile = {
      id: 'mac-argv-recorder',
      name: 'Mac argv recorder',
      family: 'codex',
      command: [
        process.execPath,
        path.join(REPO, 'tests/e2e/fixtures/argv-recorder.mjs'),
        'mac-only-' + world.run
      ],
      additionalArgs: ['--from-mac']
    }
    const missing = 'clave-e2e-no-such-program-' + world.run
    for (const p of [
      profile,
      {
        id: 'mac-missing-program',
        name: 'Mac missing program',
        family: 'codex',
        command: [missing],
        additionalArgs: []
      }
    ])
      await win.evaluate((p) => window.electronAPI.launchProfileUpsert(p), p)

    const before = await request(a, '/launch-profiles')
    const peerProfiles = await request(b, '/launch-profiles')
    const peerSessions = await request(b, '/sessions')
    const localBefore = await win.evaluate(() => window.electronAPI.listSessions())
    const journalFile = terminalJournalPath(a.dataDir)
    assert.equal(journalFile, path.join(a.dataDir, 'terminal-journal.jsonl'))
    const spawnLines = () =>
      existsSync(journalFile)
        ? readFileSync(journalFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(JSON.parse)
            .filter((line) => line.kind === 'spawn')
        : []
    const seen = spawnLines().length
    const info = await win.evaluate(
      ({ owner, cwd }) =>
        window.electronAPI.fleetStart(owner, cwd, {
          codexMode: true,
          launchProfileId: 'mac-argv-recorder'
        }),
      { owner, cwd: a.root }
    )
    await ownerReady(mac, owner, info.id)
    const row = win.locator(`[data-sidebar-item-id="${info.id}"]`)
    const tile = win.locator(`[data-terminal-tile="${info.id}"]`)
    await row.click()
    await tile.locator('.xterm').waitFor()
    const file = path.join(a.root, 'argv-record.jsonl')
    const lines = () =>
      existsSync(file)
        ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
        : []
    await eventually(() => lines().length === 1, 'the Mac-only command ran on its owner')
    const first = lines()[0]
    const prefix = ['mac-only-' + world.run, '--from-mac']
    assert.deepEqual(first.argv.slice(0, 2), prefix)
    assert.ok(first.argv.includes('-c'), 'server appends the Codex title configuration')
    assert.equal(typeof first.sessionId, 'string')
    assert.ok(first.sessionId.length > 0)
    assert.equal(realpathSync(first.cwd), realpathSync(a.root))
    assert.ok(existsSync(terminalJournalPath(a.dataDir)))
    const spawns = spawnLines().slice(seen)
    assert.equal(spawns.length, 1)
    assert.deepEqual(spawns[0].options.launchProfile.command, profile.command)
    assert.equal(spawns[0].options.launchProfileId, 'mac-argv-recorder')
    t.check('a Mac-only launch profile reaches the actual server process argv', true)

    assert.deepEqual(await request(a, '/launch-profiles'), before)
    assert.deepEqual(await request(b, '/launch-profiles'), peerProfiles)
    assert.deepEqual(await request(b, '/sessions'), peerSessions)
    assert.deepEqual(await win.evaluate(() => window.electronAPI.listSessions()), localBefore)
    t.check('the launch stores no profiles and creates no peer or Mac sessions', true)

    const idsBefore = (await request(a, '/sessions')).map((s) => s.id).sort()
    await assert.rejects(
      win.evaluate(
        ({ owner, cwd }) =>
          window.electronAPI.fleetStart(owner, cwd, {
            codexMode: true,
            launchProfileId: 'mac-missing-program'
          }),
        { owner, cwd: a.root }
      ),
      (error) => error.message.includes(missing)
    )
    assert.deepEqual((await request(a, '/sessions')).map((s) => s.id).sort(), idsBefore)
    assert.equal(lines().length, 1)
    t.check('a missing carried program refuses the start by name without a new session', true)

    assert.deepEqual(mac.errors, [])
    await mac.close()
    await world.restart(0)
    const returned = await world.mac('a', { reuse: mac.dir })
    returned.owners = await returned.win.evaluate(() => window.electronAPI.fleetList())
    await eventually(async () => {
      try {
        return !!(await returned.win.evaluate((id) => window.electronAPI.fleetSnapshot(id), owner))
      } catch {
        return false
      }
    }, 'the reopened Mac reaches the restarted server')
    await showServer(returned, 0)
    await ownerReady(returned, owner, info.id)
    await clickReady(returned.win.locator(`[data-sidebar-item-id="${info.id}"]`))
    const returnedTile = returned.win.locator(`[data-terminal-tile="${info.id}"]`)
    await returnedTile.waitFor()
    await returnedTile.getByRole('button', { name: 'Resume', exact: true }).click()
    await eventually(() => lines().length === 2, 'Resume runs the same carried command')
    assert.deepEqual(lines()[1].argv.slice(0, 2), prefix)
    assert.equal(lines()[1].sessionId, first.sessionId)
    assert.deepEqual(await request(a, '/launch-profiles'), before)
    assert.deepEqual(returned.errors, [])
    t.check('explicit Resume after a daemon restart retains the Mac-only launch profile', true)
  } finally {
    await world.close()
  }
}
